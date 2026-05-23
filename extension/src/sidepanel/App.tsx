import { useEffect, useRef, useState } from 'react';
import {
  ChatStats,
  DEFAULT_SETTINGS,
  PORT_NAME,
  RequestMessage,
  ResponseMessage,
  Settings,
} from '../shared/messages';

type ChatMsg = { role: 'user' | 'assistant'; text: string; stats?: ChatStats };

export default function App() {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [goal, setGoal] = useState<string>('');
  const [input, setInput] = useState<string>('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [streaming, setStreaming] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [connStatus, setConnStatus] = useState<'unknown' | 'ok' | 'fail'>('unknown');
  const [connError, setConnError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Open a long-lived port to the service worker on mount.
  useEffect(() => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    portRef.current = port;

    port.onMessage.addListener((msg: ResponseMessage) => {
      switch (msg.type) {
        case 'chat.chunk':
          setStreaming((prev) => prev + msg.content);
          break;
        case 'chat.complete':
          setStreaming((prev) => {
            if (prev) {
              setMessages((ms) => [...ms, { role: 'assistant', text: prev, stats: msg.stats }]);
            }
            return '';
          });
          setIsStreaming(false);
          break;
        case 'chat.error':
          setStreaming((prev) => {
            const text = prev
              ? prev + '\n\n[error: ' + msg.message + ']'
              : '[error: ' + msg.message + ']';
            setMessages((ms) => [...ms, { role: 'assistant', text }]);
            return '';
          });
          setIsStreaming(false);
          break;
        case 'settings.value':
          setSettings(msg.settings);
          break;
        case 'ollama.ping.result':
          setConnStatus(msg.ok ? 'ok' : 'fail');
          setConnError(msg.error ?? null);
          setAvailableModels(msg.models ?? []);
          break;
      }
    });

    send(port, { type: 'settings.get' });
    send(port, { type: 'ollama.ping' });

    return () => port.disconnect();
  }, []);

  // Auto-scroll the messages pane to the bottom on new content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  function send(port: chrome.runtime.Port, msg: RequestMessage) {
    port.postMessage(msg);
  }

  function sendMessage() {
    const text = input.trim();
    if (!text || isStreaming || !portRef.current) return;
    setMessages((ms) => [...ms, { role: 'user', text }]);
    setInput('');
    setStreaming('');
    setIsStreaming(true);
    send(portRef.current, {
      type: 'chat.start',
      userText: text,
      goal: goal.trim() || undefined,
    });
  }

  function abortStream() {
    if (!portRef.current) return;
    send(portRef.current, { type: 'chat.abort' });
    setIsStreaming(false);
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
          <button className="goal-clear" onClick={() => setGoal('')} title="Clear goal">
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
            <span>Enable thinking mode</span>
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
        </div>
      )}

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && !isStreaming && (
          <div className="welcome">
            <p>Ask anything to test the connection to your local model.</p>
            <p className="muted">M1: chat only. The agent loop arrives in M2.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <div className="msg-text">{m.text}</div>
            {m.stats && (
              <div className="msg-stats">
                {m.stats.genTokens ?? '?'} tokens ·{' '}
                {m.stats.tokPerSec ? m.stats.tokPerSec.toFixed(1) : '?'} tok/s ·{' '}
                {((m.stats.wallMs ?? 0) / 1000).toFixed(1)}s
              </div>
            )}
          </div>
        ))}
        {isStreaming && (
          <div className="msg msg-assistant streaming">
            <div className="msg-text">
              {streaming}
              <span className="cursor">▋</span>
            </div>
          </div>
        )}
      </div>

      <div className="goal-input">
        <input
          type="text"
          placeholder="Set a goal (optional) — Polaris will stay locked to it…"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </div>

      <div className="composer">
        <textarea
          rows={3}
          placeholder="Type a message…  (Enter to send, Shift+Enter for newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button className="send abort" onClick={abortStream}>
            Stop
          </button>
        ) : (
          <button className="send" onClick={sendMessage} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
