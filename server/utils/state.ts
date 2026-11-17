import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { identify } from "~/utils/providers";

/** A process launched through `process_start` and still known to this server. */
export type TrackedProcess = {
  id: string;
  pid?: number;
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
  startedAt: number;
  status: "running" | "exited" | "killed" | "error";
  exitCode: number | null;
  child: ChildProcess | null;
  stdout: string;
  stderr: string;
  readOffset: { stdout: number; stderr: number };
  maxBuffer: number;
};

/** A background search started through `search_files` / `search_content`. */
export type SearchTask = {
  id: string;
  kind: "files" | "content";
  query: string;
  status: "running" | "completed" | "stopped" | "error";
  startedAt: number;
  finishedAt?: number;
  scanned: number;
  matches: Record<string, unknown>[];
  maxResults: number;
  error?: string;
  controller: AbortController;
};

export type ToolCallRecord = {
  ts: string;
  tool: string;
  args: string;
  durationMs: number;
  success: boolean;
  actor: string;
  ip: string | null;
};

export type ToolUsage = {
  calls: number;
  successes: number;
  failures: number;
  totalMs: number;
  lastCalledAt: string;
};

export type ServerConfig = {
  /** Base directory used to resolve relative paths. */
  defaultCwd: string;
  /** Hard cap for text returned by tools. */
  maxOutputBytes: number;
  /** Largest file `file_read` / `search_content` will load into memory. */
  maxFileReadBytes: number;
  /** Default result cap for searches. */
  maxSearchResults: number;
  /** Maximum number of simultaneously tracked processes. */
  maxProcesses: number;
  /** Maximum number of retained search tasks. */
  maxSearches: number;
  /** Whether dot-files are included when no flag is given. */
  includeHidden: boolean;
  /** Mask values of environment variables that look like secrets. */
  maskSecrets: boolean;
  /** Number of tool calls kept in `tool_history`. */
  historyLimit: number;
  /** Optional path allow-list. Empty means unrestricted. */
  allowedRoots: string[];
  [key: string]: unknown;
};

const config: ServerConfig = {
  defaultCwd: process.cwd(),
  maxOutputBytes: 100_000,
  maxFileReadBytes: 5_000_000,
  maxSearchResults: 1_000,
  maxProcesses: 64,
  maxSearches: 32,
  includeHidden: false,
  maskSecrets: true,
  historyLimit: 500,
  allowedRoots: [],
};

/**
 * Process-wide state shared by every tool registration. It is intentionally a
 * module singleton: the MCP handler creates a server per session, but the
 * processes, searches and statistics it exposes belong to the host process.
 */
export const state = {
  session: {
    id: randomUUID(),
    startedAt: Date.now(),
  },
  config,
  processes: new Map<string, TrackedProcess>(),
  searches: new Map<string, SearchTask>(),
  history: [] as ToolCallRecord[],
  usage: new Map<string, ToolUsage>(),
  registeredTools: new Set<string>(),
};

let processCounter = 0;
let searchCounter = 0;

export function nextProcessId(): string {
  processCounter += 1;
  return `p${processCounter.toString(36)}_${randomUUID().slice(0, 6)}`;
}

export function nextSearchId(): string {
  searchCounter += 1;
  return `s${searchCounter.toString(36)}_${randomUUID().slice(0, 6)}`;
}

export function markToolName(name: string): void {
  state.registeredTools.add(name);
}

/** Records one tool invocation for `usage_stats` and `tool_history`. */
export function recordToolCall(
  tool: string,
  args: unknown,
  durationMs: number,
  success: boolean,
  ip: string | null = null,
): void {
  const identity = identify(ip);
  let serialized = "";
  try {
    serialized = JSON.stringify(args ?? {});
  } catch {
    serialized = "[unserializable]";
  }

  const record: ToolCallRecord = {
    ts: new Date().toISOString(),
    tool,
    args: serialized.length > 800 ? `${serialized.slice(0, 800)}…` : serialized,
    durationMs,
    success,
    actor: identity.actor,
    ip: identity.ip,
  };

  state.history.push(record);
  const limit = configNumber("historyLimit", 500);
  if (state.history.length > limit)
    state.history.splice(0, state.history.length - limit);

  const usage = state.usage.get(tool) ?? {
    calls: 0,
    successes: 0,
    failures: 0,
    totalMs: 0,
    lastCalledAt: record.ts,
  };
  usage.calls += 1;
  if (success) usage.successes += 1;
  else usage.failures += 1;
  usage.totalMs += durationMs;
  usage.lastCalledAt = record.ts;
  state.usage.set(tool, usage);
}

/** Appends to a capped string buffer, keeping the newest bytes. */
export function appendCapped(
  current: string,
  chunk: string,
  max: number,
): string {
  if (!chunk) return current;
  const next = current + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

export function configNumber(key: string, fallback: number): number {
  const value = state.config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function configBool(key: string, fallback: boolean): boolean {
  const value = state.config[key];
  return typeof value === "boolean" ? value : fallback;
}

export function configString(key: string, fallback: string): string {
  const value = state.config[key];
  return typeof value === "string" ? value : fallback;
}
