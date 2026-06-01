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
import type { OpSummary } from '../agent/metrics';
import type { DomainTier } from '../agent/domain_tiers';

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
  // Per-op metrics summary for the most recently completed run. Fetched
  // lazily on `agent.terminal` and discarded on the next `agent.start` /
  // clearAgent. Stored alongside its taskId so a stale response (slow IDB
  // tail-read) can't paint over a fresh task.
  const [taskMetrics, setTaskMetrics] = useState<{ taskId: string; summary: OpSummary[] } | null>(null);
  // Domain trust tiers for the settings UI. Lazy-fetched when the drawer
  // opens; updated on every successful `domainTiers.set` echo.
  const [domainTiers, setDomainTierMap] = useState<Record<string, DomainTier>>({});
  const [newDomainHost, setNewDomainHost] = useState<string>('');
  const [newDomainTier, setNewDomainTier] = useState<DomainTier>('click-only');
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
        case 'agent.events': {
          // Batched event replay (resume path). One postMessage carrying
          // up to ~100 events; expand here into a single setAgentRun
          // update so the timeline doesn't trigger N React re-renders.
          if (msg.events.length === 0) break;
          // Find the latest planner role_end so we lift the plan / criteria
          // exactly like the singleton case would have, in one pass.
          let plannerPlan: Plan | undefined;
          let plannerCriteria: string[] | undefined;
          for (const ev of msg.events) {
            if (ev.type === 'role_end') {
              const d = ev.data as
                | { role?: string; plan?: Plan; successCriteria?: string[] }
                | undefined;
              if (d?.role === 'planner' && d.plan) {
                plannerPlan = d.plan;
                plannerCriteria = d.successCriteria ?? plannerCriteria;
              }
            }
          }
          // A batched replay never leaves the UI in "awaiting model" — by
          // definition every event in it has already settled.
          setLastRoleStartAt(null);
          setAgentRun((run) =>
            run
              ? {
                  ...run,
                  plan: plannerPlan ?? run.plan,
                  successCriteria: plannerCriteria ?? run.successCriteria,
                  events: [...run.events, ...msg.events],
                }
              : run,
          );
          break;
        }
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
        case 'metrics.value':
          setTaskMetrics({ taskId: msg.taskId, summary: msg.summary });
          break;
        case 'domainTiers.value':
          setDomainTierMap(msg.tiers);
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

  // After the agent terminates, fetch the per-op metrics summary so the
  // panel can render a small per-role latency table beneath the run.
  // Skipped when taskId is still the optimistic placeholder ('...') —
  // that means agent.started never settled and there's nothing in IDB
  // to summarize.
  useEffect(() => {
    const run = agentRun;
    if (!run || run.terminal == null) return;
    if (!run.taskId || run.taskId === '...') return;
    if (taskMetrics?.taskId === run.taskId) return; // already fetched
    send(null, { type: 'metrics.get', taskId: run.taskId });
  }, [agentRun?.terminal, agentRun?.taskId]);

  // Lazy-fetch the domain-tier map when the settings drawer opens. Closed
  // drawer means the panel doesn't need it; opening triggers a fresh read
  // so a tier change made in another tab's panel is visible here too.
  useEffect(() => {
    if (drawerOpen) {
      send(null, { type: 'domainTiers.list' });
    }
  }, [drawerOpen]);

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
    setTaskMetrics(null);
    setInput('');
    send(portRef.current, { type: 'agent.start', goal: goalText });
  }

  function abortAgent() {
    if (!portRef.current) return;
    send(portRef.current, { type: 'agent.abort' });
  }

  function clearAgent() {
    setAgentRun(null);
    setTaskMetrics(null);
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

  type ModelSource = 'default' | 'local26b' | 'cloud';
  const LOCAL_26B = 'gemma4:26b';

  function roleSource(role: 'planner' | 'executor' | 'evaluator'): ModelSource {
    if (settings.cloud?.[role]?.apiKey) return 'cloud';
    if (settings.roleModels?.[role]) return 'local26b';
    return 'default';
  }

  function setRoleSource(role: 'planner' | 'executor' | 'evaluator', source: ModelSource) {
    const roleModels = { ...(settings.roleModels ?? {}) };
    const cloud = { ...(settings.cloud ?? {}) };
    if (source === 'local26b') {
      roleModels[role] = LOCAL_26B;
      delete cloud[role];
    } else if (source === 'cloud') {
      delete roleModels[role];
      cloud[role] = cloud[role] ?? { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' };
    } else {
      delete roleModels[role];
      delete cloud[role];
    }
    send(null, { type: 'settings.set', settings: { roleModels, cloud } });
  }

  function updateCloudField(role: 'planner' | 'executor' | 'evaluator', field: 'baseUrl' | 'apiKey' | 'model', value: string) {
    const cloud = { ...(settings.cloud ?? {}) };
    const existing = cloud[role] ?? { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' };
    cloud[role] = { ...existing, [field]: value };
    send(null, { type: 'settings.set', settings: { cloud } });
  }

  function testConnection() {
    if (!portRef.current) return;
    setConnStatus('unknown');
    setConnError(null);
    send(portRef.current, { type: 'ollama.ping' });
  }

  function addDomainTier() {
    const host = normalizeHostInput(newDomainHost);
    if (!host) return;
    send(null, { type: 'domainTiers.set', host, tier: newDomainTier });
    setNewDomainHost('');
  }

  function updateDomainTier(host: string, tier: DomainTier) {
    send(null, { type: 'domainTiers.set', host, tier });
  }

  function removeDomainTier(host: string) {
    send(null, { type: 'domainTiers.set', host, tier: null });
  }

  function resetAgentState() {
    if (!portRef.current) return;
    if (!confirm('Wipe persistent agent state? (Clears any stuck/zombie task. Chat history in this panel is unaffected.)')) return;
    setAgentRun(null);
    setLastRoleStartAt(null);
    setResumable(null);
    setTaskMetrics(null);
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
    setTaskMetrics(null);
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
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={settings.executorThinking}
              onChange={(e) => updateSetting('executorThinking', e.target.checked)}
            />
            <span>Thinking mode for Executor (slower but may improve tool selection)</span>
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
          <div className="drawer-section">
            <div className="drawer-section-head">
              <span className="drawer-section-label">Domain trust tiers</span>
              <span className="drawer-section-hint">
                Default <code>read-only</code>. Upgrade per host to let the agent click or type.
              </span>
            </div>
            {Object.keys(domainTiers).length > 0 ? (
              <ul className="domain-tier-list">
                {Object.entries(domainTiers)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([host, tier]) => (
                    <li key={host} className="domain-tier-row">
                      <span className="domain-tier-host" title={host}>{host}</span>
                      <select
                        value={tier}
                        onChange={(e) => updateDomainTier(host, e.target.value as DomainTier)}
                      >
                        <option value="read-only">read-only</option>
                        <option value="click-only">click-only</option>
                        <option value="full-action">full-action</option>
                      </select>
                      <button
                        className="domain-tier-remove"
                        onClick={() => removeDomainTier(host)}
                        aria-label={`Remove ${host}`}
                        title="Revert to default (read-only)"
                      >
                        ×
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <div className="muted-hint">No custom tiers — every host is read-only.</div>
            )}
            <div className="domain-tier-add">
              <input
                type="text"
                placeholder="e.g. amazon.com"
                value={newDomainHost}
                onChange={(e) => setNewDomainHost(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addDomainTier();
                  }
                }}
              />
              <select
                value={newDomainTier}
                onChange={(e) => setNewDomainTier(e.target.value as DomainTier)}
              >
                <option value="read-only">read-only</option>
                <option value="click-only">click-only</option>
                <option value="full-action">full-action</option>
              </select>
              <button onClick={addDomainTier} disabled={!newDomainHost.trim()}>
                Add
              </button>
            </div>
          </div>
          <div className="drawer-section">
            <div className="drawer-section-head">
              <span className="drawer-section-label">Model source per role</span>
              <span className="drawer-section-hint">
                Default is fully local (e4b). <code>26B</code> uses {LOCAL_26B} for higher-quality
                reasoning (slower). <code>Cloud</code> sends PII-anonymized prompts to your own key.
              </span>
            </div>
            {(['planner', 'executor', 'evaluator'] as const).map((role) => (
              <div key={role} className="role-model-row">
                <span className="role-model-label">{role}</span>
                <select
                  value={roleSource(role)}
                  onChange={(e) => setRoleSource(role, e.target.value as ModelSource)}
                >
                  <option value="default">Default (e4b)</option>
                  <option value="local26b">26B (slower, 256K ctx)</option>
                  <option value="cloud">Cloud (BYOK)</option>
                </select>
                {roleSource(role) === 'cloud' && (
                  <div className="role-cloud-fields">
                    <input
                      type="text"
                      placeholder="baseUrl"
                      value={settings.cloud?.[role]?.baseUrl ?? ''}
                      onChange={(e) => updateCloudField(role, 'baseUrl', e.target.value)}
                    />
                    <input
                      type="password"
                      placeholder="apiKey"
                      value={settings.cloud?.[role]?.apiKey ?? ''}
                      onChange={(e) => updateCloudField(role, 'apiKey', e.target.value)}
                    />
                    <input
                      type="text"
                      placeholder="model (e.g. deepseek-chat)"
                      value={settings.cloud?.[role]?.model ?? ''}
                      onChange={(e) => updateCloudField(role, 'model', e.target.value)}
                    />
                  </div>
                )}
              </div>
            ))}
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
            {agentRun.terminal != null &&
              taskMetrics != null &&
              taskMetrics.taskId === agentRun.taskId &&
              taskMetrics.summary.length > 0 && (
                <MetricsBlock summary={taskMetrics.summary} />
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
      const pt = d.promptTokens != null ? ` · ${String(d.promptTokens)}t in` : '';
      const gt = d.genTokens != null ? ` / ${String(d.genTokens)}t out` : '';
      return (
        <>
          <span className="tag">{String(d.role ?? '?')}</span>
          {d.retried ? <span className="retry-badge">retried</span> : null}
          {' '}{ok}{pt}{gt}
          {d.thinking ? (
            <div className="thinking-trace"><CollapsibleText text={String(d.thinking)} cap={300} /></div>
          ) : null}
        </>
      );
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
    case 'breaker': {
      const action = String(d.action ?? 'replan');
      return (
        <>
          <span className="breaker-icon" aria-hidden>⚠</span>
          <span className="breaker-label">Circuit breaker: {action}</span>
          <span className="breaker-reason"> — </span>
          <CollapsibleText text={String(d.reason ?? 'no reason')} inline cap={120} className="breaker-reason" />
        </>
      );
    }
    case 'compaction': {
      const discarded = Number(d.discarded ?? 0);
      const produced = Number(d.produced ?? 0);
      const pt = d.promptTokens != null ? Number(d.promptTokens) : null;
      const gt = d.genTokens != null ? Number(d.genTokens) : null;
      return (
        <>
          <span className="compaction-icon" aria-hidden>↘</span>
          <span className="compaction-label">
            Compaction: archived {discarded} {discarded === 1 ? 'entry' : 'entries'} → {produced} {produced === 1 ? 'finding' : 'findings'}
          </span>
          {(pt != null || gt != null) && (
            <div className="compaction-cost">
              cost: {pt ?? '?'}t in / {gt ?? '?'}t out
            </div>
          )}
        </>
      );
    }
    case 'verdict':
      return (
        <>
          <span className="tag">verdict</span> {String(d.verdict ?? '?')}
          {d.reason ? (
            <>
              {' — '}
              <CollapsibleText text={String(d.reason)} inline cap={120} />
            </>
          ) : null}
        </>
      );
    case 'error':
      return (
        <>
          <span className="tag tag-error">error</span>{' '}
          <CollapsibleText text={String(d.error ?? '?')} inline cap={120} />
        </>
      );
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
 * Renders text up to a per-call cap (default TEXT_VISIBLE_CAP); if longer,
 * shows a truncated preview with a "Show full (N chars)" toggle. Prevents
 * model misfires from dumping tens of KB into the panel without recourse.
 *
 * Inline timeline events pass `cap={120}` to keep one-line rendering;
 * the expand toggle reveals the full text on demand.
 */
function CollapsibleText({
  text,
  className,
  inline = false,
  cap,
}: {
  text: string;
  className?: string;
  inline?: boolean;
  cap?: number;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const limit = cap ?? TEXT_VISIBLE_CAP;
  const long = text.length > limit;
  const shown = !long || expanded ? text : text.slice(0, limit) + '…';
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

/**
 * Per-op latency / success-rate table rendered under a terminal run.
 * Mirrors `polaris.metrics.summary(taskId)` from the SW console — same
 * data, just visible without DevTools. Sorted by mean latency desc to
 * surface the slowest role first.
 */
function MetricsBlock({ summary }: { summary: OpSummary[] }): JSX.Element {
  return (
    <div className="agent-metrics">
      <div className="agent-metrics-head">Per-op latency</div>
      <table className="agent-metrics-table">
        <thead>
          <tr>
            <th>op</th>
            <th>n</th>
            <th>ok</th>
            <th>p50</th>
            <th>p95</th>
            <th>mean</th>
          </tr>
        </thead>
        <tbody>
          {summary.map((s) => (
            <tr key={s.op}>
              <td>{s.op}</td>
              <td>{s.count}</td>
              <td>{Math.round(s.successRate * 100)}%</td>
              <td>{formatMs(s.p50LatencyMs)}</td>
              <td>{formatMs(s.p95LatencyMs)}</td>
              <td>{formatMs(s.meanLatencyMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Normalize a user-typed domain into the canonical `host` form that
 * `domain_tiers.canonicalHost` produces. Tolerates pasted URLs, missing
 * protocol, and `www.` prefixes. Empty string if input is unparseable.
 */
function normalizeHostInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    const host = u.host.replace(/^www\./i, '');
    if (host) return host;
  } catch {
    // fall through
  }
  return trimmed.replace(/^www\./i, '');
}
