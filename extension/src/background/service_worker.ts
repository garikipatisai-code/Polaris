// Polaris background service worker.
// M1 scope: route messages between the side panel and Ollama. No agent loop yet.

import { PORT_NAME, RequestMessage, ResponseMessage } from '../shared/messages';
import { getSettings, setSettings } from './settings';
import { OllamaClient, ChatMessage } from './ollama';

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[polaris] sidePanel.setPanelBehavior failed', e));

// One in-flight chat at a time; abort cancels current generation.
let currentAbort: AbortController | null = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  port.onMessage.addListener(async (msg: RequestMessage) => {
    try {
      switch (msg.type) {
        case 'settings.get': {
          const settings = await getSettings();
          send(port, { type: 'settings.value', settings });
          break;
        }
        case 'settings.set': {
          const settings = await setSettings(msg.settings);
          send(port, { type: 'settings.value', settings });
          break;
        }
        case 'ollama.ping': {
          const s = await getSettings();
          const c = new OllamaClient(s.ollamaBaseUrl);
          const r = await c.ping();
          send(port, {
            type: 'ollama.ping.result',
            ok: r.ok,
            error: r.error,
            models: r.models,
          });
          break;
        }
        case 'chat.abort': {
          currentAbort?.abort();
          currentAbort = null;
          break;
        }
        case 'chat.start': {
          await handleChat(port, msg.userText, msg.goal);
          break;
        }
      }
    } catch (e) {
      console.error('[polaris] handler error', e);
      send(port, { type: 'chat.error', message: (e as Error).message });
    }
  });

  port.onDisconnect.addListener(() => {
    currentAbort?.abort();
    currentAbort = null;
  });
});

function send(port: chrome.runtime.Port, msg: ResponseMessage): void {
  try {
    port.postMessage(msg);
  } catch {
    // Port may already be closed; nothing to do.
  }
}

async function handleChat(
  port: chrome.runtime.Port,
  userText: string,
  goal?: string,
): Promise<void> {
  const settings = await getSettings();
  const client = new OllamaClient(settings.ollamaBaseUrl);

  const systemPrompt = goal
    ? `You are Polaris, a focused local browser assistant. The user's current goal is: "${goal}". Stay grounded in that goal in every reply. Be concise.`
    : 'You are Polaris, a focused local browser assistant. Be concise and useful.';

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText },
  ];

  currentAbort?.abort();
  currentAbort = new AbortController();

  const start = performance.now();
  let promptTokens = 0;
  let genTokens = 0;

  try {
    // Attempt the chat stream; on 403 the model needs to be loaded first.
    let stream = client.chatStream({
      model: settings.model,
      messages,
      think: settings.enableThinking,
      signal: currentAbort.signal,
    });

    // Poll once to detect a 403 early — the generator hasn't yielded yet.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of stream) {
      // If we get here, streaming started normally — no 403.
      // Note: the real iteration resumes below using the same client call.
      break;
    }
  } catch (e) {
    const err = e as Error;
    // 403 means model not loaded — trigger a background load then retry.
    if (err.message.includes('403')) {
      try {
        send(port, { type: 'chat.status', status: 'warming', message: 'Loading model…' });
        await loadModel(client, settings.model, currentAbort.signal);
      } catch (loadErr) {
        send(port, { type: 'chat.error', message: `Model load failed: ${(loadErr as Error).message}` });
        return;
      }
      // Retry once — model is now in memory.
      const retryStart = performance.now();
      for await (const chunk of client.chatStream({
        model: settings.model,
        messages,
        think: settings.enableThinking,
        signal: currentAbort.signal,
      })) {
        const content = chunk.message?.content;
        if (content) send(port, { type: 'chat.chunk', content });
        if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
        if (chunk.eval_count) genTokens = chunk.eval_count;
        if (chunk.done) break;
      }
      const wallMs = performance.now() - retryStart;
      const tokPerSec = genTokens && wallMs > 0 ? genTokens / (wallMs / 1000) : undefined;
      send(port, { type: 'chat.complete', stats: { promptTokens, genTokens, tokPerSec, wallMs } });
      currentAbort = null;
      return;
    }
    // Non-403 error.
    if (err.name === 'AbortError') return;
    send(port, { type: 'chat.error', message: err.message });
    currentAbort = null;
    return;
  }

  // Normal streaming path (no 403 on first attempt).
  // Re-create the stream since we consumed one iteration in the probe above.
  // We re-use messages since no tokens were generated yet.
  for await (const chunk of client.chatStream({
    model: settings.model,
    messages,
    think: settings.enableThinking,
    signal: currentAbort.signal,
  })) {
    const content = chunk.message?.content;
    if (content) send(port, { type: 'chat.chunk', content });
    if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
    if (chunk.eval_count) genTokens = chunk.eval_count;
    if (chunk.done) break;
  }
  const wallMs = performance.now() - start;
  const tokPerSec = genTokens && wallMs > 0 ? genTokens / (wallMs / 1000) : undefined;
  send(port, { type: 'chat.complete', stats: { promptTokens, genTokens, tokPerSec, wallMs } });
  currentAbort = null;
}

async function loadModel(
  client: OllamaClient,
  model: string,
  signal: AbortSignal,
): Promise<void> {
  // Use /api/generate with keep_alive to force model into memory.
  // Ollama loads the model on first request and keeps it resident per keep_alive.
  const res = await fetch(client.url('/api/generate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: ' ', stream: false, keep_alive: -1 }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => 'no body');
    throw new Error(`load HTTP ${res.status}: ${detail}`);
  }
}
