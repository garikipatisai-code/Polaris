// Polaris background service worker.
// M1 scope: route messages between the side panel and Ollama.
// M2.1: persistent state store + types added; agent loop arrives in M2.3+.

import { PORT_NAME, RequestMessage, ResponseMessage } from '../shared/messages';
import { getSettings, setSettings } from './settings';
import { OllamaClient, ChatMessage } from './ollama';
import * as stateStore from '../agent/state_store';
import * as idb from '../agent/idb';
import * as budget from '../agent/budget';
import { ulid } from '../agent/ulid';
import * as tools from '../agent/tools';
import * as logModule from '../agent/log';
import { Orchestrator } from '../agent/orchestrator';

// Expose agent primitives on globalThis.polaris so the SW DevTools console
// can introspect and exercise the store directly. Cheap in bundle terms;
// invaluable for debugging.
(globalThis as unknown as { polaris: unknown }).polaris = {
  state: stateStore,
  idb,
  budget,
  ulid,
  tools,
  log: logModule.log,
  logs: logModule.getLogs,
  dumpLogs: logModule.dumpLogs,
  clearLogs: logModule.clearLogs,
};
console.log('[polaris] state + tools primitives → globalThis.polaris (try polaris.dumpLogs())');

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[polaris] sidePanel.setPanelBehavior failed', e));

// ----------------------------------------------------------------------------
// Watchdog (M2.6)
// ----------------------------------------------------------------------------
// chrome.alarms wakes us periodically. If a task is in a non-terminal phase
// and lastTouch is older than WATCHDOG_STALE_MS, we mark it ABORTED — covers
// the case where the SW died mid-task and can't continue itself. The
// orchestrator's own state mutations bump lastTouch via patchHot(), so a
// healthy active task touches state every Executor turn.

const WATCHDOG_ALARM = 'polaris.watchdog';
const WATCHDOG_INTERVAL_MIN = 1; // chrome.alarms enforces ≥1 min in production MV3
const WATCHDOG_STALE_MS = 5 * 60 * 1000; // 5 minutes — generous to tolerate slow Planner calls
const TERMINAL_PHASES = new Set(['IDLE', 'DONE', 'ABORTED']);

chrome.alarms?.create?.(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_INTERVAL_MIN });

chrome.alarms?.onAlarm?.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  try {
    const state = await stateStore.loadHot();
    if (!state) return;
    if (TERMINAL_PHASES.has(state.phase)) return;
    const idle = Date.now() - (state.lastTouch ?? state.createdAt);
    if (idle > WATCHDOG_STALE_MS) {
      console.warn(
        `[polaris] watchdog: task ${state.taskId} stuck in ${state.phase} for ${Math.round(idle / 1000)}s — aborting`,
      );
      await stateStore.patchHot({ phase: 'ABORTED' });
    }
  } catch (e) {
    console.warn('[polaris] watchdog tick failed', e);
  }
});

// One in-flight chat at a time; abort cancels current generation.
let currentAbort: AbortController | null = null;

// At most one Orchestrator instance per SW lifetime (single-task model per
// M2 design). Set on agent.start, cleared on terminal phase.
let currentOrchestrator: Orchestrator | null = null;

// Show "Loading model…" status if the first token doesn't arrive within this window.
// Cold loads of qwen3.5:4b take ~3–5s on the target hardware.
const WARMING_NOTICE_MS = 3000;

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
        case 'agent.start': {
          await handleAgentStart(port, msg.goal);
          break;
        }
        case 'agent.resume': {
          await handleAgentResume(port);
          break;
        }
        case 'agent.abort': {
          await currentOrchestrator?.stop();
          break;
        }
        case 'agent.reset': {
          await currentOrchestrator?.stop();
          await stateStore.clearHot();
          const snapshot = await stateStore.loadHot();
          send(port, { type: 'agent.snapshot', state: snapshot });
          break;
        }
        case 'agent.getSnapshot': {
          const state = await stateStore.loadHot();
          send(port, { type: 'agent.snapshot', state });
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

function systemPromptFor(goal?: string): string {
  return goal
    ? `You are Polaris, a focused local browser assistant. The user's current goal is: "${goal}". Stay grounded in that goal in every reply. Be concise.`
    : 'You are Polaris, a focused local browser assistant. Be concise and useful.';
}

async function handleChat(
  port: chrome.runtime.Port,
  userText: string,
  goal?: string,
): Promise<void> {
  const settings = await getSettings();
  const client = new OllamaClient(settings.ollamaBaseUrl);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPromptFor(goal) },
    { role: 'user', content: userText },
  ];

  currentAbort?.abort();
  currentAbort = new AbortController();
  const abortSignal = currentAbort.signal;

  const start = performance.now();
  let promptTokens = 0;
  let genTokens = 0;
  let firstChunkSeen = false;

  // If the first token hasn't arrived after WARMING_NOTICE_MS, surface a
  // "Loading model…" status so the user doesn't think we hung.
  const warmingTimer = setTimeout(() => {
    if (!firstChunkSeen) {
      send(port, {
        type: 'chat.status',
        status: 'warming',
        message: 'Loading model into memory…',
      });
    }
  }, WARMING_NOTICE_MS);

  try {
    for await (const chunk of client.chatStream({
      model: settings.model,
      messages,
      think: settings.enableThinking,
      signal: abortSignal,
    })) {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        clearTimeout(warmingTimer);
      }
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
    send(port, { type: 'chat.error', message: explainError(e as Error) });
  } finally {
    clearTimeout(warmingTimer);
    currentAbort = null;
  }
}

function explainError(e: Error): string {
  const msg = e.message;
  // 403 from Ollama is almost always a CORS rejection — Origin header from
  // chrome-extension://* isn't whitelisted server-side.
  if (msg.includes('403')) {
    return (
      'Ollama rejected the request (HTTP 403). Most likely a CORS issue — ' +
      'set OLLAMA_ORIGINS="chrome-extension://*" on the Ollama server. ' +
      'See README.md "CORS setup" for details.'
    );
  }
  // Network failure when fetching localhost typically means Ollama isn't
  // running, or the URL is wrong.
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
    return (
      'Could not reach Ollama. Check that the server is running and the ' +
      'URL in Polaris settings is correct.'
    );
  }
  return msg;
}

async function handleAgentStart(port: chrome.runtime.Port, goal: string): Promise<void> {
  if (currentOrchestrator) {
    send(port, {
      type: 'agent.terminal',
      phase: 'ABORTED',
      error: 'an agent task is already running — abort it first',
    });
    return;
  }
  const settings = await getSettings();
  const client = new OllamaClient(settings.ollamaBaseUrl);

  let lastSummary: string | undefined;
  let lastError: string | undefined;

  const orchestrator = new Orchestrator({
    client,
    model: settings.model,
    plannerThinking: settings.plannerThinking,
    evaluatorThinking: settings.evaluatorThinking,
    onEvent: (event) => {
      send(port, { type: 'agent.event', event });
      if (event.type === 'verdict') {
        const d = event.data as { summary?: string; verdict?: string; reason?: string; finalAnswer?: string } | undefined;
        if (d?.verdict === 'done' && d.finalAnswer) lastSummary = d.finalAnswer;
        if (d?.verdict === 'done' && d.summary) lastSummary = d.summary;
        if (d?.verdict === 'abort') lastError = d.reason ?? 'aborted';
      }
      if (event.type === 'error') {
        const d = event.data as { error?: string } | undefined;
        if (d?.error) lastError = d.error;
      }
    },
  });
  currentOrchestrator = orchestrator;

  try {
    const initial = await orchestrator.start(goal);
    send(port, { type: 'agent.started', taskId: initial.taskId, goal: initial.goal.text });
    const terminal = await orchestrator.runUntilTerminal();
    send(port, {
      type: 'agent.terminal',
      phase: terminal.phase === 'DONE' ? 'DONE' : 'ABORTED',
      summary: terminal.finalAnswer ?? lastSummary,
      error: lastError,
    });
  } catch (e) {
    send(port, {
      type: 'agent.terminal',
      phase: 'ABORTED',
      error: explainError(e as Error),
    });
  } finally {
    currentOrchestrator = null;
  }
}

async function handleAgentResume(port: chrome.runtime.Port): Promise<void> {
  if (currentOrchestrator) {
    send(port, {
      type: 'agent.terminal',
      phase: 'ABORTED',
      error: 'an agent task is already running — abort it first',
    });
    return;
  }
  const state = await stateStore.loadHot();
  if (!state) {
    send(port, { type: 'agent.terminal', phase: 'ABORTED', error: 'nothing to resume' });
    return;
  }
  if (TERMINAL_PHASES.has(state.phase)) {
    send(port, {
      type: 'agent.terminal',
      phase: 'ABORTED',
      error: `task already terminal (phase=${state.phase})`,
    });
    return;
  }

  // Tell the panel about the run BEFORE the orchestrator emits any events.
  // Otherwise the orchestrator's first event (phase resume) arrives while
  // agentRun is still null and gets dropped by the panel's event handler.
  send(port, { type: 'agent.started', taskId: state.taskId, goal: state.goal.text });
  send(port, {
    type: 'agent.event',
    event: {
      type: 'role_end',
      data: {
        role: 'planner',
        ok: true,
        plan: state.plan,
        successCriteria: state.goal.successCriteria,
        resumed: true,
      },
    },
  });

  const settings = await getSettings();
  const client = new OllamaClient(settings.ollamaBaseUrl);

  let lastSummary: string | undefined;
  let lastError: string | undefined;

  const orchestrator = new Orchestrator({
    client,
    model: settings.model,
    plannerThinking: settings.plannerThinking,
    evaluatorThinking: settings.evaluatorThinking,
    onEvent: (event) => {
      send(port, { type: 'agent.event', event });
      if (event.type === 'verdict') {
        const d = event.data as { summary?: string; verdict?: string; reason?: string; finalAnswer?: string } | undefined;
        if (d?.verdict === 'done' && d.finalAnswer) lastSummary = d.finalAnswer;
        if (d?.verdict === 'abort') lastError = d.reason ?? 'aborted';
      }
      if (event.type === 'error') {
        const d = event.data as { error?: string } | undefined;
        if (d?.error) lastError = d.error;
      }
    },
  });
  currentOrchestrator = orchestrator;

  try {
    await orchestrator.resume();
    const terminal = await orchestrator.runUntilTerminal();
    send(port, {
      type: 'agent.terminal',
      phase: terminal.phase === 'DONE' ? 'DONE' : 'ABORTED',
      summary: terminal.finalAnswer ?? lastSummary,
      error: lastError,
    });
  } catch (e) {
    send(port, {
      type: 'agent.terminal',
      phase: 'ABORTED',
      error: explainError(e as Error),
    });
  } finally {
    currentOrchestrator = null;
  }
}
