import { useEffect, useRef, useState } from 'react';
import {
  AgentEventPayload,
  ChatStats,
  DEFAULT_SETTINGS,
  PORT_NAME,
  RequestMessage,
  ResponseMessage,
  Settings,
} from '../shared/messages';
import type { Plan, PlanStep } from '../shared/agent_types';

type ChatMsg = { role: 'user' | 'assistant'; text: string; stats?: ChatStats };

interface AgentRun {
  taskId: string;
  goal: string;
  plan: Plan | null;
  successCriteria: string[];
  events: AgentEventPayload[];
  terminal: { phase: 'DONE' | 'ABORTED'; summary?: string; error?: string } | null;
}

interface ResumableSnapshot {
  taskId: string;
  goal: string;
  phase: string;
  lastTouch: number;
}

const NON_TERMINAL_PHASES = new Set(['PLANNING', 'EXECUTING', 'COMPACTING', 'EVALUATING', 'BREAKER']);

export default function App() {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [goal, setGoal] = useState<string>('');
  const [input, setInput] = useState<string>('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [streaming, setStreaming] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [warmingNotice, setWarmingNotice] = useState<string | null>(null);
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [lastRoleStartAt, setLastRoleStartAt] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const [resumable, setResumable] = useState<ResumableSnapshot | null>(null);
  // Buffer for outbound messages while the port is disconnected. Drained on
  // reconnect (the connect() function does its own initial sync). Capped to
  // avoid unbounded growth if reconnect never succeeds.
  const queuedMessages = useRef<RequestMessage[]>([]);
  const MAX_QUEUE = 20;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [connStatus, setConnStatus] = useState<'unknown' | 'ok' | 'fail'>('unknown');
  const [connError, setConnError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Open a long-lived port to the service worker on mount, with auto-reconnect
  // when the SW idle-kills the port (Chrome MV3 sweeps SWs after ~30s of no
  // work — any stale postMessage then throws "disconnected port").
  useEffect(() => {
    let active = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const handleMessage = (msg: ResponseMessage) => {
      if (!active) return;
      switch (msg.type) {
        case 'chat.chunk':
          setWarmingNotice(null);
          setStreaming((prev) => prev + msg.content);
          break;
        case 'chat.complete':
          setWarmingNotice(null);
          setStreaming((prev) => {
            if (prev) {
              setMessages((ms) => [...ms, { role: 'assistant', text: prev, stats: msg.stats }]);
            }
            return '';
          });
          setIsStreaming(false);
          break;
        case 'chat.error':
          setWarmingNotice(null);
          setStreaming((prev) => {
            const text = prev
              ? prev + '\n\n[error: ' + msg.message + ']'
              : '[error: ' + msg.message + ']';
            setMessages((ms) => [...ms, { role: 'assistant', text }]);
            return '';
          });
          setIsStreaming(false);
          break;
        case 'chat.status':
          if (msg.status === 'warming') {
            setWarmingNotice(msg.message);
          }
          break;
        case 'settings.value':
          setSettings(msg.settings);
          break;
        case 'ollama.ping.result':
          setConnStatus(msg.ok ? 'ok' : 'fail');
          setConnError(msg.error ?? null);
          setAvailableModels(msg.models ?? []);
          break;
        case 'agent.started':
          setAgentRun({
            taskId: msg.taskId,
            goal: msg.goal,
            plan: null,
            successCriteria: [],
            events: [],
            terminal: null,
          });
          setLastRoleStartAt(null);
          break;
        case 'agent.event':
          if (msg.event.type === 'role_start') {
            setLastRoleStartAt(Date.now());
          } else if (
            msg.event.type === 'tool_call' ||
            msg.event.type === 'tool_result' ||
            msg.event.type === 'role_end' ||
            msg.event.type === 'verdict' ||
            msg.event.type === 'error'
          ) {
            setLastRoleStartAt(null);
          }
          // Pull Plan + successCriteria out of the planner's role_end event.
          if (msg.event.type === 'role_end') {
            const d = msg.event.data as
              | { role?: string; plan?: Plan; successCriteria?: string[] }
              | undefined;
            if (d?.role === 'planner' && d.plan) {
              setAgentRun((run) =>
                run
                  ? {
                      ...run,
                      plan: d.plan ?? run.plan,
                      successCriteria: d.successCriteria ?? run.successCriteria,
                      events: [...run.events, msg.event],
                    }
                  : run,
              );
              break;
            }
          }
          setAgentRun((run) => (run ? { ...run, events: [...run.events, msg.event] } : run));
          break;
        case 'agent.terminal':
          setLastRoleStartAt(null);
          setAgentRun((run) =>
            run
              ? { ...run, terminal: { phase: msg.phase, summary: msg.summary, error: msg.error } }
              : run,
          );
          break;
        case 'agent.snapshot':
          // If there's a non-terminal task in storage AND no in-memory run,
          // surface a resume card. Triggered on panel mount — covers the
          // SW-restart / browser-restart case.
          if (msg.state && NON_TERMINAL_PHASES.has(msg.state.phase)) {
            setResumable({
              taskId: msg.state.taskId,
              goal: msg.state.goal.text,
              phase: msg.state.phase,
              lastTouch: msg.state.lastTouch,
            });
          } else {
            setResumable(null);
          }
          break;
      }
    };

    const connect = () => {
      if (!active) return;
      const port = chrome.runtime.connect({ name: PORT_NAME });
      portRef.current = port;
      port.onMessage.addListener(handleMessage);
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        if (!active) return;
        const reason = chrome.runtime.lastError?.message ?? 'idle';
        console.warn(`[polaris] background port disconnected (${reason}) — reconnecting in 500ms`);
        reconnectTimer = setTimeout(connect, 500);
      });
      sendOn(port, { type: 'settings.get' });
      sendOn(port, { type: 'ollama.ping' });
      sendOn(port, { type: 'agent.getSnapshot' });
      // Drain any messages queued while we were disconnected.
      const drained = queuedMessages.current.splice(0);
      for (const msg of drained) sendOn(port, msg);
      if (drained.length > 0) {
        console.info(`[polaris] flushed ${drained.length} queued message(s) after reconnect`);
      }
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, []);

  // Auto-scroll the messages pane to the bottom on new content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming, warmingNotice, agentRun]);

  // Tick every 500ms while we're waiting on the model so the "awaiting model…"
  // counter updates live.
  useEffect(() => {
    if (lastRoleStartAt == null) return;
    const interval = setInterval(() => forceTick((t) => t + 1), 500);
    return () => clearInterval(interval);
  }, [lastRoleStartAt]);

  function sendOn(port: chrome.runtime.Port, msg: RequestMessage): boolean {
    try {
      port.postMessage(msg);
      return true;
    } catch (e) {
      console.warn(`[polaris] postMessage(${msg.type}) failed — port disconnected`, e);
      portRef.current = null;
      return false;
    }
  }

  /** Send a message to the SW, tolerating a disconnected port. Returns success. */
  function send(_port: chrome.runtime.Port | null, msg: RequestMessage): boolean {
    const port = portRef.current;
    if (!port) {
      // Port is disconnected — queue the message; the next connect() drains it.
      if (queuedMessages.current.length < MAX_QUEUE) {
        queuedMessages.current.push(msg);
        console.warn(`[polaris] port down; queued ${msg.type} (queue size ${queuedMessages.current.length})`);
      } else {
        console.warn(`[polaris] queue full (${MAX_QUEUE}); dropped ${msg.type}`);
      }
      return false;
    }
    const ok = sendOn(port, msg);
    if (!ok && queuedMessages.current.length < MAX_QUEUE) {
      // sendOn already nulled portRef; queue for the upcoming reconnect.
      queuedMessages.current.push(msg);
    }
    return ok;
  }

  function sendMessage() {
    const text = input.trim();
    if (!text || isStreaming || !portRef.current) return;
    setMessages((ms) => [...ms, { role: 'user', text }]);
    setInput('');
    setStreaming('');
    setWarmingNotice(null);
    setIsStreaming(true);
    send(portRef.current, {
      type: 'chat.start',
      userText: text,
      goal: goal.trim() || undefined,
    });
  }

  function startAgent() {
    const goalText = goal.trim();
    if (!goalText || agentRunning || !portRef.current) return;
    // Auto-clear any prior terminal run so the new one renders fresh.
    setAgentRun({
      taskId: '...',
      goal: goalText,
      plan: null,
      successCriteria: [],
      events: [],
      terminal: null,
    });
    setInput('');
    send(portRef.current, { type: 'agent.start', goal: goalText });
  }

  function abortAgent() {
    if (!portRef.current) return;
    send(portRef.current, { type: 'agent.abort' });
  }

  function clearAgent() {
    setAgentRun(null);
  }

  function abortStream() {
    if (!portRef.current) return;
    send(portRef.current, { type: 'chat.abort' });
    setWarmingNotice(null);
    setIsStreaming(false);
  }

  /** Single primary action: send chat if no goal, run agent if goal is set. */
  function onPrimaryAction() {
    if (goal.trim()) {
      startAgent();
    } else {
      sendMessage();
    }
  }

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    if (!portRef.current) return;
    send(portRef.current, { type: 'settings.set', settings: { [key]: value } as Partial<Settings> });
  }

  function testConnection() {
    if (!portRef.current) return;
    setConnStatus('unknown');
    setConnError(null);
    send(portRef.current, { type: 'ollama.ping' });
  }

  function resetAgentState() {
    if (!portRef.current) return;
    if (!confirm('Wipe persistent agent state? (Clears any stuck/zombie task. Chat history in this panel is unaffected.)')) return;
    setAgentRun(null);
    setLastRoleStartAt(null);
    setResumable(null);
    send(portRef.current, { type: 'agent.reset' });
  }

  function resumeAgent() {
    if (!portRef.current || !resumable) return;
    setAgentRun({
      taskId: resumable.taskId,
      goal: resumable.goal,
      plan: null,
      successCriteria: [],
      events: [],
      terminal: null,
    });
    setResumable(null);
    send(portRef.current, { type: 'agent.resume' });
  }

  function discardResumable() {
    if (!portRef.current) return;
    if (!confirm('Discard the incomplete task? Its goal, plan and findings will be wiped.')) return;
    setResumable(null);
    send(portRef.current, { type: 'agent.reset' });
  }

  const agentRunning = agentRun !== null && agentRun.terminal === null;

  return (
    <div className="polaris">
      <header className="polaris-header">
        <div className="polaris-title">
          <span className="star">★</span>
          <span>Polaris</span>
        </div>
        <div className="polaris-status">
          <span
            className={`dot ${connStatus}`}
            title={connError ?? (connStatus === 'ok' ? 'Connected' : 'Status unknown')}
          />
          <button
            className="gear"
            onClick={() => setDrawerOpen((v) => !v)}
            title="Settings"
            aria-label="Toggle settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {goal.trim() && (
        <div className="goal-banner">
          <span className="goal-label">Goal:</span>
          <span className="goal-text">{goal}</span>
          <button
            className="goal-clear"
            onClick={() => setGoal('')}
            title="Clear goal"
            disabled={agentRunning}
          >
            ×
          </button>
        </div>
      )}

      {drawerOpen && (
        <div className="drawer">
          <label className="field">
            <span>Ollama URL</span>
            <input
              type="text"
              value={settings.ollamaBaseUrl}
              onChange={(e) => updateSetting('ollamaBaseUrl', e.target.value)}
              placeholder="http://localhost:11434"
            />
          </label>
          <label className="field">
            <span>Model</span>
            <input
              type="text"
              value={settings.model}
              onChange={(e) => updateSetting('model', e.target.value)}
              placeholder="qwen3.5:4b"
              list="polaris-models"
            />
            <datalist id="polaris-models">
              {availableModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={settings.enableThinking}
              onChange={(e) => updateSetting('enableThinking', e.target.checked)}
            />
            <span>Enable thinking mode for chat</span>
          </label>
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={settings.plannerThinking}
              onChange={(e) => updateSetting('plannerThinking', e.target.checked)}
            />
            <span>Thinking mode for Planner (slower but higher-quality plans)</span>
          </label>
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={settings.evaluatorThinking}
              onChange={(e) => updateSetting('evaluatorThinking', e.target.checked)}
            />
            <span>Thinking mode for Evaluator (M2.5+)</span>
          </label>
          <div className="drawer-actions">
            <button onClick={testConnection}>Test connection</button>
            {connStatus !== 'unknown' && (
              <span className={`conn-status ${connStatus}`}>
                {connStatus === 'ok'
                  ? `✓ Connected · ${availableModels.length} models`
                  : `✗ ${connError ?? 'Connection failed'}`}
              </span>
            )}
          </div>
          <div className="drawer-actions">
            <button className="danger" onClick={resetAgentState}>
              Reset agent state
            </button>
            <span className="muted-hint">Wipes persistent task state if stuck.</span>
          </div>
        </div>
      )}

      <div className="messages" ref={scrollRef}>
        {resumable && !agentRun && (
          <div className="resume-card">
            <div className="resume-head">
              <span className="resume-label">⏸ Incomplete task</span>
              <span className="resume-phase">{resumable.phase}</span>
            </div>
            <div className="resume-goal">{resumable.goal}</div>
            <div className="resume-meta">
              Last activity {Math.round((Date.now() - resumable.lastTouch) / 1000)}s ago
            </div>
            <div className="resume-actions">
              <button className="resume-resume" onClick={resumeAgent}>
                Resume
              </button>
              <button className="resume-discard" onClick={discardResumable}>
                Discard
              </button>
            </div>
          </div>
        )}

        {messages.length === 0 && !isStreaming && !agentRun && !resumable && (
          <div className="welcome">
            <p>Ask anything to chat with your local model.</p>
            <p className="muted">
              Or set a <strong>goal</strong> in the field above to switch to <strong>agent mode</strong>.
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <MessageBubble key={i} m={m} />
        ))}

        {isStreaming && (
          <div className="msg msg-assistant streaming">
            <div className="msg-text">
              {warmingNotice && !streaming ? (
                <span className="warming">⋯ {warmingNotice}</span>
              ) : (
                <>
                  {streaming}
                  <span className="cursor">▋</span>
                </>
              )}
            </div>
          </div>
        )}

        {agentRun && (
          <div className={`agent-run ${agentRun.terminal ? `terminal-${agentRun.terminal.phase.toLowerCase()}` : 'running'}`}>
            <div className="agent-run-head">
              <span className="agent-run-label">{agentRun.terminal ? '★ Agent run' : '★ Polaris is working…'}</span>
              {agentRunning && (
                <button className="agent-abort" onClick={abortAgent}>
                  Abort
                </button>
              )}
              {agentRun.terminal && (
                <button className="agent-clear" onClick={clearAgent}>
                  Clear
                </button>
              )}
            </div>
            <div className="agent-goal">
              <span className="agent-goal-label">Goal:</span> {agentRun.goal}
            </div>
            {agentRun.successCriteria.length > 0 && (
              <div className="agent-criteria">
                <span className="agent-criteria-label">Success criteria:</span>
                <ul>
                  {agentRun.successCriteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {agentRun.plan && agentRun.plan.rootSteps.length > 0 && (
              <PlanView plan={agentRun.plan} />
            )}
            <ol className="agent-timeline">
              {agentRun.events.map((e, i) => (
                <li key={i} className={`agent-event agent-event-${e.type}`}>
                  {renderEvent(e)}
                </li>
              ))}
              {agentRunning && agentRun.events.length === 0 && (
                <li className="agent-event agent-event-pending">
                  <span className="warming">⋯ Starting up…</span>
                </li>
              )}
              {agentRunning && lastRoleStartAt != null && (
                <li className="agent-event agent-event-pending">
                  <span className="warming">
                    ⋯ awaiting model… {Math.floor((Date.now() - lastRoleStartAt) / 1000)}s
                  </span>
                </li>
              )}
            </ol>
            {agentRun.terminal?.phase === 'DONE' && agentRun.terminal.summary && (
              <div className="agent-summary">
                <span className="agent-summary-label">Final answer:</span>
                <CollapsibleText text={agentRun.terminal.summary} className="agent-summary-text" />
              </div>
            )}
            {agentRun.terminal?.phase === 'ABORTED' && (
              <div className="agent-error">
                <span className="agent-error-label">Aborted:</span>{' '}
                <CollapsibleText text={agentRun.terminal.error ?? 'unknown reason'} inline />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="goal-input">
        <input
          type="text"
          placeholder="Set a goal to switch to agent mode (leave empty to chat)…"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          disabled={agentRunning}
        />
        {goal.trim() && !agentRunning && (
          <span className="mode-indicator" title="Send button will run as an agent task because a goal is set">
            🚀 agent mode
          </span>
        )}
      </div>

      <div className="composer">
        <textarea
          rows={3}
          placeholder={
            agentRunning
              ? 'Polaris is working — press Abort to stop.'
              : goal.trim()
                ? 'Optional: extra notes for the agent (the goal above is the primary input)'
                : 'Type a message (Enter to send)'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onPrimaryAction();
            }
          }}
          disabled={isStreaming || agentRunning}
        />
        {isStreaming ? (
          <button className="send abort" onClick={abortStream}>
            Stop
          </button>
        ) : goal.trim() ? (
          <button
            className="send agent"
            onClick={startAgent}
            disabled={agentRunning}
            title="Run as an agent task with the goal above"
          >
            🚀 Run agent
          </button>
        ) : (
          <button
            className="send"
            onClick={sendMessage}
            disabled={!input.trim() || agentRunning}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function renderEvent(e: AgentEventPayload): JSX.Element {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'phase':
      return <><span className="tag">phase</span> → {String(d.phase ?? '?')}</>;
    case 'role_start':
      return <><span className="tag">{String(d.role ?? '?')}</span> start{d.stepId ? ` (step ${String(d.stepId)})` : ''}</>;
    case 'role_end': {
      const ok = d.ok ? '✓' : '✗';
      const retried = d.retried ? ' (retried)' : '';
      const pt = d.promptTokens != null ? ` · ${String(d.promptTokens)}t in` : '';
      const gt = d.genTokens != null ? ` / ${String(d.genTokens)}t out` : '';
      return <><span className="tag">{String(d.role ?? '?')}</span> {ok}{retried}{pt}{gt}</>;
    }
    case 'tool_call': {
      const args = d.args ? JSON.stringify(d.args) : '{}';
      return <><span className="tag">tool</span> {String(d.name ?? '?')}({truncate(args, 60)})</>;
    }
    case 'tool_result': {
      const ok = d.ok ? '✓' : '✗';
      const summary = d.ok ? truncate(JSON.stringify(d.data ?? {}), 80) : String(d.error ?? '');
      return <><span className="tag">→</span> {ok} {summary}</>;
    }
    case 'breaker':
      return <><span className="tag">breaker</span> {String(d.reason ?? '?')}</>;
    case 'compaction':
      return <><span className="tag">compact</span> {String(d.discarded ?? '?')} discarded → {String(d.produced ?? '?')} findings</>;
    case 'verdict':
      return <><span className="tag">verdict</span> {String(d.verdict ?? '?')}{d.reason ? ` — ${String(d.reason)}` : ''}</>;
    case 'error':
      return <><span className="tag tag-error">error</span> {truncate(String(d.error ?? '?'), 120)}</>;
    default:
      return <>{e.type}</>;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Cap on visible text in a chat / agent-summary bubble before we offer a "show full" toggle. */
const TEXT_VISIBLE_CAP = 2000;

function MessageBubble({ m }: { m: ChatMsg }): JSX.Element {
  return (
    <div className={`msg msg-${m.role}`}>
      <CollapsibleText text={m.text} className="msg-text" />
      {m.stats && (
        <div className="msg-stats">
          {m.stats.genTokens ?? '?'} tokens ·{' '}
          {m.stats.tokPerSec ? m.stats.tokPerSec.toFixed(1) : '?'} tok/s ·{' '}
          {((m.stats.wallMs ?? 0) / 1000).toFixed(1)}s
        </div>
      )}
    </div>
  );
}

/**
 * Renders text up to TEXT_VISIBLE_CAP chars; if longer, shows a truncated
 * preview with a "Show full (Nk chars)" toggle. Prevents model misfires
 * from dumping tens of KB into the panel without recourse.
 */
function CollapsibleText({
  text,
  className,
  inline = false,
}: {
  text: string;
  className?: string;
  inline?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > TEXT_VISIBLE_CAP;
  const shown = !long || expanded ? text : text.slice(0, TEXT_VISIBLE_CAP) + '…';
  const sizeLabel = text.length > 1024
    ? `${(text.length / 1024).toFixed(1)} KB`
    : `${text.length} chars`;
  if (inline) {
    return (
      <>
        <span className={className}>{shown}</span>
        {long && (
          <button className="collapsible-toggle" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Collapse' : `Show full (${sizeLabel})`}
          </button>
        )}
      </>
    );
  }
  return (
    <>
      <div className={className}>{shown}</div>
      {long && (
        <button className="collapsible-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Collapse' : `Show full (${sizeLabel})`}
        </button>
      )}
    </>
  );
}

/** Hierarchical plan view — one level of nesting, status pills, rev number. */
function PlanView({ plan }: { plan: Plan }): JSX.Element {
  return (
    <div className="agent-plan">
      <div className="agent-plan-head">
        <span className="agent-plan-label">Plan</span>
        <span className="agent-plan-rev">rev {plan.revision}</span>
      </div>
      <ol className="agent-plan-tree">
        {plan.rootSteps.map((s) => (
          <PlanStepView key={s.id} step={s} />
        ))}
      </ol>
      {plan.notes && <div className="agent-plan-notes">{plan.notes}</div>}
    </div>
  );
}

function PlanStepView({ step }: { step: PlanStep }): JSX.Element {
  return (
    <li className={`plan-step plan-step-${step.status}`}>
      <div className="plan-step-row">
        <span className={`plan-step-status status-${step.status}`}>{statusIcon(step.status)}</span>
        <span className="plan-step-id">{step.id}</span>
        <span className="plan-step-title">{step.title}</span>
      </div>
      {step.rationale && <div className="plan-step-rationale">{step.rationale}</div>}
      {step.children && step.children.length > 0 && (
        <ol className="plan-children">
          {step.children.map((c) => (
            <PlanStepView key={c.id} step={c} />
          ))}
        </ol>
      )}
    </li>
  );
}

function statusIcon(s: PlanStep['status']): string {
  switch (s) {
    case 'done': return '✓';
    case 'active': return '►';
    case 'skipped': return '~';
    case 'failed': return '✗';
    case 'pending': default: return '○';
  }
}
