import type { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod"

const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 600_000
const MAX_OUTPUT = 100_000

const isWindows = process.platform === "win32"
const isMacOS = process.platform === "darwin"

const shell = isWindows ? "powershell.exe" : "bash"
const shellArgs = isWindows
  ? ["-NoProfile", "-NonInteractive", "-Command"]
  : ["-c"]
const title = isWindows
  ? "Execute PowerShell Command"
  : isMacOS
    ? "Execute Bash Command on macOS"
    : "Execute Bash Command on Linux"
const description = isWindows
  ? "Run a PowerShell command on the machine hosting this server and return its output."
  : "Run a Bash command on the machine hosting this server and return its output."

export function registerExecTool(server: McpServer) {
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
            "Working directory for the command (defaults to the server's working directory)"
          ),
        timeout: z
          .number()
          .int()
          .positive()
          .max(MAX_TIMEOUT)
          .optional()
          .describe(
            `Timeout in milliseconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})`
          )
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ command, cwd, timeout }) => {
      const proc = Bun.spawn([shell, ...shellArgs, command], {
        cwd: cwd ?? process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" }
      })

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, timeout ?? DEFAULT_TIMEOUT)

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text()
      ])
      const exitCode = await proc.exited
      clearTimeout(timer)

      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
      const text = [
        output ? output.slice(0, MAX_OUTPUT) : "(no output)",
        output.length > MAX_OUTPUT ? "... (output truncated)" : "",
        `exit code: ${exitCode}${timedOut ? " (timed out)" : ""}`
      ]
        .filter(Boolean)
        .join("\n")

      return {
        content: [{ type: "text" as const, text }],
        isError: exitCode !== 0
      }
    }
  )
}
