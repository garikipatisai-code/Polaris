// In-memory log buffer for post-mortem debugging.
//
// Every meaningful event (Ollama request/response, phase transition, role
// invocation, breaker decision, compactor trigger, error) calls log().
// Entries are pushed into a fixed-size ring buffer that's exposed at
// globalThis.polaris.logs() so a SW DevTools session can pull the recent
// history without losing the live console formatting.
//
// Each entry is also forwarded to console.{info,warn,error} so live tailing
// the SW console works as before.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory =
  | 'ollama'
  | 'agent'
  | 'planner'
  | 'executor'
  | 'evaluator'
  | 'compactor'
  | 'breaker'
  | 'state'
  | 'panel'
  | 'sw';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: unknown;
}

const MAX_BUFFER = 1000;
const buffer: LogEntry[] = [];

export function log(
  level: LogLevel,
  category: LogCategory,
  message: string,
  data?: unknown,
): void {
  const entry: LogEntry = { ts: Date.now(), level, category, message, data };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  const prefix = `[polaris:${category}]`;
  const args: unknown[] = data !== undefined ? [prefix, message, data] : [prefix, message];
  switch (level) {
    case 'error':
      console.error(...args);
      break;
    case 'warn':
      console.warn(...args);
      break;
    case 'info':
      console.info(...args);
      break;
    case 'debug':
    default:
      console.log(...args);
      break;
  }
}

export function getLogs(opts: { since?: number; level?: LogLevel; category?: LogCategory } = {}): LogEntry[] {
  return buffer.filter((e) => {
    if (opts.since && e.ts < opts.since) return false;
    if (opts.level && e.level !== opts.level) return false;
    if (opts.category && e.category !== opts.category) return false;
    return true;
  });
}

export function clearLogs(): void {
  buffer.length = 0;
}

/** Compact tabular dump of recent logs. Use from SW console: `polaris.dumpLogs()`. */
export function dumpLogs(opts?: Parameters<typeof getLogs>[0]): void {
  const logs = getLogs(opts);
  // eslint-disable-next-line no-console
  console.table(
    logs.map((e) => ({
      t: new Date(e.ts).toISOString().slice(11, 23),
      lvl: e.level,
      cat: e.category,
      msg: e.message.slice(0, 80),
    })),
  );
}
