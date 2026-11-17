import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { identify } from "~/utils/providers";
import { audit } from "~/utils/log";
import { markToolName, recordToolCall } from "~/utils/state";
import { spawn } from "node:child_process";
import { text as readStreamText } from "node:stream/consumers";

const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 100_000;

const isWindows = process.platform === "win32";
const isMacOS = process.platform === "darwin";

const shell = isWindows ? "powershell.exe" : "bash";
const shellArgs = isWindows
  ? ["-NoProfile", "-NonInteractive", "-Command"]
  : ["-c"];
const title = isWindows
  ? "Execute PowerShell Command"
  : isMacOS
    ? "Execute Bash Command on macOS"
    : "Execute Bash Command on Linux";
const description = isWindows
  ? "Run a PowerShell command on the machine hosting this server and return its output."
  : "Run a Bash command on the machine hosting this server and return its output.";

export type ExecContext = {
  /** Address of the client that issued the call, when known. */
  ip: string | null;
};

export function registerExecTool(server: McpServer, context?: ExecContext) {
  markToolName("exec");
  server.registerTool(
    "exec",
    {
      title,
      description,
      inputSchema: z.object({
        command: z.string().min(1).describe("The command to run"),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory for the command (defaults to the server's working directory)",
          ),
        timeout: z
          .number()
          .int()
          .positive()
          .max(MAX_TIMEOUT)
          .optional()
          .describe(
            `Timeout in milliseconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})`,
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, cwd, timeout }) => {
      const identity = identify(context?.ip);
      const startedAt = Date.now();
      const workdir = cwd ?? process.cwd();

      try {
        const proc = spawn(shell, [...shellArgs, command], {
          cwd: workdir,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, NO_COLOR: "1" },
        });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeout ?? DEFAULT_TIMEOUT);

        let stdout = "";
        let stderr = "";
        let exitCode: number | null = null;

        try {
          [stdout, stderr, exitCode] = await Promise.all([
            readStreamText(proc.stdout),
            readStreamText(proc.stderr),
            new Promise<number | null>((resolve, reject) => {
              proc.on("error", reject);
              proc.on("close", resolve);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }

        const resolvedExitCode = exitCode ?? (timedOut ? 143 : 1);

        audit({
          event: "exec",
          actor: identity.actor,
          ip: identity.ip,
          command,
          cwd: workdir,
          exitCode: resolvedExitCode,
          timedOut,
          durationMs: Date.now() - startedAt,
        });

        const output = [stdout.trim(), stderr.trim()]
          .filter(Boolean)
          .join("\n");
        const responseText = [
          output ? output.slice(0, MAX_OUTPUT) : "(no output)",
          output.length > MAX_OUTPUT ? "... (output truncated)" : "",
          `exit code: ${resolvedExitCode}${timedOut ? " (timed out)" : ""}`,
        ]
          .filter(Boolean)
          .join("\n");

        recordToolCall(
          "exec",
          { command, cwd: workdir, timeout },
          Date.now() - startedAt,
          resolvedExitCode === 0,
          identity.ip,
        );
        return {
          content: [{ type: "text" as const, text: responseText }],
          isError: resolvedExitCode !== 0,
        };
      } catch (error) {
        audit({
          event: "exec",
          actor: identity.actor,
          ip: identity.ip,
          command,
          cwd: workdir,
          exitCode: -1,
          error: (error as Error).message,
          durationMs: Date.now() - startedAt,
        });
        recordToolCall(
          "exec",
          { command, cwd: workdir, timeout },
          Date.now() - startedAt,
          false,
          identity.ip,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to run command: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
