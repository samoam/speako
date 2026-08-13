export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  seq: number;
  timestamp: string;
  level: LogLevel;
  message: string;
}

const MAX_ENTRIES = 500;
const LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error'];

const buffer: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();
let seq = 0;
let patched = false;

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function record(level: LogLevel, args: unknown[]): void {
  const entry: LogEntry = {
    seq: ++seq,
    timestamp: new Date().toISOString(),
    level,
    message: args.map(formatArg).join(' '),
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  for (const listener of listeners) listener(entry);
}

/** Wraps console.log/info/warn/error so every call still prints to stdout/stderr as before, while also feeding the in-memory ring buffer that the Logs panel reads from. Idempotent — a live-reload or repeated require() won't double-wrap. */
export function patchConsole(): void {
  if (patched) return;
  patched = true;
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      record(level, args);
    };
  }
}

export function getLogBuffer(): LogEntry[] {
  return buffer.slice();
}

export function onLogEntry(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
