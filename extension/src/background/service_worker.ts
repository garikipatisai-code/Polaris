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
    send(port, {
      type: 'chat.complete',
      stats: { promptTokens, genTokens, tokPerSec, wallMs },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    send(port, { type: 'chat.error', message: (e as Error).message });
  } finally {
    currentAbort = null;
  }
}
