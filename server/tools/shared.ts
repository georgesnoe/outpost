import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { audit } from "~/utils/log";
import { identify } from "~/utils/providers";
import { configString, markToolName, recordToolCall } from "~/utils/state";

export { configBool, configNumber, configString } from "~/utils/state";

export type ToolContext = { ip: string | null };

export type TextContent = { type: "text"; text: string };

/** MCP image block — the agent can actually see this image. */
export type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ToolResult = {
  content: (TextContent | ImageContent)[];
  isError?: boolean;
};

export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";
export const PLATFORM = process.platform;

export const SHELL = IS_WINDOWS ? "powershell.exe" : "bash";
export const SHELL_ARGS = IS_WINDOWS
  ? ["-NoProfile", "-NonInteractive", "-Command"]
  : ["-c"];

export const ANNOTATIONS = {
  read: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  write: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  destructive: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  open: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
} as const;

/** Successful text result. */
export function ok(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/** Failed text result. */
export function fail(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return fail(`Error: ${message}`);
}

export function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated ${text.length - max} chars)`;
}

/** Result containing a PNG/JPEG screenshot as MCP ImageContent. */
export function imageResult(
  base64: string,
  mimeType = "image/png",
): ToolResult {
  return { content: [{ type: "image" as const, data: base64, mimeType }] };
}

export function jsonResult(data: unknown, maxBytes = 100_000): ToolResult {
  let text: string;
  try {
    text = JSON.stringify(data, null, 2);
  } catch {
    text = String(data);
  }
  return ok(truncate(text, maxBytes));
}

/**
 * Wraps every tool handler so calls are uniformly timed, recorded in the
 * history / usage tables and converted into a well-formed tool result when an
 * exception escapes.
 */
export async function executeTool(
  name: string,
  args: unknown,
  handler: () => Promise<ToolResult> | ToolResult,
  ip: string | null = null,
): Promise<ToolResult> {
  markToolName(name);
  const startedAt = Date.now();
  let success = false;
  try {
    const result = await handler();
    success = result.isError !== true;
    return result;
  } catch (error) {
    return errorResult(error);
  } finally {
    recordToolCall(name, args, Date.now() - startedAt, success, ip);
  }
}

/** Writes an audit entry using the caller's identity. */
export function auditAction(
  event: string,
  context: ToolContext | undefined,
  extra: Record<string, unknown> = {},
): void {
  const identity = identify(context?.ip);
  audit({ event, actor: identity.actor, ip: identity.ip, ...extra });
}

/** Expands `~` and environment variables, then resolves against the base dir. */
export function resolvePath(input: string, base?: string): string {
  let value = input.trim();
  if (value === "~") {
    value = homedir();
  } else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = join(homedir(), value.slice(2));
  }
  value = value.replace(
    /%([A-Za-z_][A-Za-z0-9_]*)%/g,
    (match, name: string) => process.env[name] ?? match,
  );
  value = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (match, name: string) => process.env[name] ?? match,
  );
  if (!isAbsolute(value)) {
    value = resolve(base ?? configString("defaultCwd", process.cwd()), value);
  }
  return normalize(value);
}

/** Converts a simple glob (`*`, `**`, `?`, `[abc]`) into an anchored regex. */
export function globToRegExp(glob: string, caseSensitive = false): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] ?? "";
    if (char === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        pattern += "[^/\\\\]*";
      }
    } else if (char === "?") {
      pattern += "[^/\\\\]";
    } else if (char === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i) {
        pattern += glob.slice(i, end + 1);
        i = end;
      } else {
        pattern += "\\[";
      }
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`, caseSensitive ? "" : "i");
}

export function isHidden(name: string): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

export function pathForDisplay(path: string, base?: string): string {
  const root = base ?? configString("defaultCwd", process.cwd());
  if (path === root) return ".";
  if (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) {
    return path.slice(root.length + 1);
  }
  return path;
}

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
};

/** Runs a command to completion, capturing a bounded amount of output. */
export function runCapture(
  command: string,
  args: string[],
  timeout = 10_000,
  maxOutput = 100_000,
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      return next.length > maxOutput
        ? next.slice(next.length - maxOutput)
        : next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);

    child.on("error", (error) => {
      clearTimeout(timer);
      stderr += `\n${error.message}`;
      resolvePromise({ stdout, stderr, code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code: code ?? -1, timedOut });
    });
  });
}

/** Like `runCapture`, but feeds `input` to the child's stdin. */
export function runWithInput(
  command: string,
  args: string[],
  input: string,
  timeout = 10_000,
  maxOutput = 100_000,
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      return next.length > maxOutput
        ? next.slice(next.length - maxOutput)
        : next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      stderr += `\n${error.message}`;
      resolvePromise({ stdout, stderr, code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code: code ?? -1, timedOut });
    });

    if (child.stdin) {
      child.stdin.on("error", () => {
        // The child may close stdin early (e.g. pbcopy); ignore it.
      });
      child.stdin.end(input);
    }
  });
}

/** Returns a PowerShell command/argument pair. */
export function powershell(script: string): [string, string[]] {
  return [
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
  ];
}

/** Escapes a value for embedding in a single-quoted PowerShell string. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Yields to the event loop so long searches remain cancellable. */
export function yieldToLoop(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}
