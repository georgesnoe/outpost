import { spawn } from "node:child_process";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  ANNOTATIONS,
  IS_WINDOWS,
  SHELL,
  SHELL_ARGS,
  auditAction,
  executeTool,
  fail,
  jsonResult,
  ok,
  powershell,
  psQuote,
  resolvePath,
  runCapture,
  type ToolContext,
  type ToolResult,
} from "~/tools/shared";
import {
  appendCapped,
  configNumber,
  nextProcessId,
  state,
  type TrackedProcess,
} from "~/utils/state";

function findProcess(id: string): TrackedProcess | undefined {
  return state.processes.get(id);
}

function summarize(proc: TrackedProcess) {
  return {
    id: proc.id,
    pid: proc.pid ?? null,
    command: proc.command,
    args: proc.args,
    cwd: proc.cwd,
    shell: proc.shell,
    status: proc.status,
    exitCode: proc.exitCode,
    startedAt: new Date(proc.startedAt).toISOString(),
    uptimeMs: Date.now() - proc.startedAt,
    stdoutBytes: proc.stdout.length,
    stderrBytes: proc.stderr.length,
  };
}

/** Queries the OS for a PID that is not tracked by this server. */
async function queryOsProcess(pid: number): Promise<ToolResult> {
  let command: string;
  let args: string[];

  if (IS_WINDOWS) {
    const script =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
      `if ($p) { $p | Select-Object ProcessId,ParentProcessId,Name,CreationDate,` +
      `CommandLine | ConvertTo-Json -Compress } else { '' }`;
    [command, args] = powershell(script);
  } else {
    command = "ps";
    args = [
      "-p",
      String(pid),
      "-o",
      "pid=,ppid=,user=,stat=,%cpu=,%mem=,etime=,comm=,args=",
    ];
  }

  const result = await runCapture(command, args);
  if (result.code !== 0 && !result.stdout.trim()) {
    return fail(
      `Process ${pid} not found or could not be queried. ${result.stderr.trim()}`.trim(),
    );
  }
  const text = result.stdout.trim() || "(no details returned)";
  return ok(`pid ${pid} (${IS_WINDOWS ? "Windows" : "POSIX"}):\n${text}`);
}

export function registerProcessTools(
  server: McpServer,
  context?: ToolContext,
): void {
  server.registerTool(
    "process_start",
    {
      title: "Start Process",
      description:
        "Start a long-lived background process and return an id for later input/output/kill calls. Use exec for one-shot commands.",
      inputSchema: z.object({
        command: z.string().min(1).describe("Executable or command to start"),
        args: z
          .array(z.string())
          .default([])
          .describe("Arguments passed to the command"),
        cwd: z.string().optional().describe("Working directory"),
        env: z
          .record(z.string(), z.string())
          .default({})
          .describe("Extra environment variables"),
        shell: z
          .boolean()
          .default(false)
          .describe(
            "Run the command through the platform shell (PowerShell on Windows, bash elsewhere)",
          ),
        bufferKB: z
          .number()
          .int()
          .positive()
          .max(4096)
          .default(256)
          .describe("Per-stream output buffer size in KiB (default 256)"),
      }),
      annotations: ANNOTATIONS.open,
    },
    async (args) =>
      executeTool(
        "process_start",
        args,
        async () => {
          const limit = configNumber("maxProcesses", 64);
          if (state.processes.size >= limit) {
            return fail(`Too many tracked processes (limit ${limit}).`);
          }

          const cwd = resolvePath(args.cwd ?? ".");
          const child = spawn(
            args.shell ? SHELL : args.command,
            args.shell
              ? [...SHELL_ARGS, [args.command, ...args.args].join(" ")]
              : args.args,
            {
              cwd,
              env: { ...process.env, ...args.env, NO_COLOR: "1" },
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            },
          );

          const proc: TrackedProcess = {
            id: nextProcessId(),
            pid: child.pid,
            command: args.command,
            args: args.args,
            cwd,
            shell: args.shell,
            startedAt: Date.now(),
            status: "running",
            exitCode: null,
            child,
            stdout: "",
            stderr: "",
            readOffset: { stdout: 0, stderr: 0 },
            maxBuffer: args.bufferKB * 1024,
          };
          state.processes.set(proc.id, proc);

          child.stdout?.on("data", (chunk: Buffer) => {
            proc.stdout = appendCapped(
              proc.stdout,
              chunk.toString("utf8"),
              proc.maxBuffer,
            );
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            proc.stderr = appendCapped(
              proc.stderr,
              chunk.toString("utf8"),
              proc.maxBuffer,
            );
          });
          child.on("error", (error) => {
            proc.status = "error";
            proc.stderr = appendCapped(
              proc.stderr,
              `\n[process error: ${error.message}]`,
              proc.maxBuffer,
            );
            proc.child = null;
          });
          child.on("close", (code) => {
            if (proc.status === "running") proc.status = "exited";
            proc.exitCode = code;
            proc.child = null;
          });

          auditAction("process_start", context, {
            id: proc.id,
            pid: proc.pid,
            command: args.command,
            args: args.args,
            cwd,
            shell: args.shell,
          });

          return jsonResult({
            id: proc.id,
            pid: proc.pid ?? null,
            status: proc.status,
            cwd,
          });
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "process_input",
    {
      title: "Write to Process",
      description: "Send text to a running process's standard input.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Process id returned by process_start"),
        input: z.string().describe("Text to write to stdin"),
        newline: z
          .boolean()
          .default(true)
          .describe("Append a newline after the input (default true)"),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "process_input",
        args,
        async () => {
          const proc = findProcess(args.id);
          if (!proc) return fail(`Unknown process id: ${args.id}`);
          if (proc.status !== "running" || !proc.child?.stdin) {
            return fail(
              `Process ${args.id} is not running (status: ${proc.status}).`,
            );
          }
          const payload = args.newline ? `${args.input}\n` : args.input;
          await new Promise<void>((resolvePromise, reject) => {
            proc.child?.stdin?.write(payload, (error) =>
              error ? reject(error) : resolvePromise(),
            );
          });
          return ok(
            `Wrote ${Buffer.byteLength(payload)} bytes to process ${args.id}.`,
          );
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "process_output",
    {
      title: "Read Process Output",
      description:
        "Read stdout/stderr captured from a process since the last read. Offsets advance per stream.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Process id returned by process_start"),
        stream: z
          .enum(["stdout", "stderr", "both"])
          .default("both")
          .describe("Which stream to read"),
        tail: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return only the last N lines of each stream"),
        clear: z
          .boolean()
          .default(false)
          .describe("Also discard already-read data after reading"),
        wait: z
          .number()
          .int()
          .nonnegative()
          .default(0)
          .describe(
            "Milliseconds to wait for new data before returning (0 = no wait)",
          ),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "process_output",
        args,
        async () => {
          const proc = findProcess(args.id);
          if (!proc) return fail(`Unknown process id: ${args.id}`);

          const streams: ("stdout" | "stderr")[] =
            args.stream === "both" ? ["stdout", "stderr"] : [args.stream];
          if (args.wait > 0) {
            const start = Date.now();
            while (Date.now() - start < args.wait) {
              const hasNew = streams.some(
                (s) => proc[s].length > proc.readOffset[s],
              );
              if (hasNew || proc.status !== "running") break;
              await new Promise((done) => setTimeout(done, 50));
            }
          }

          const parts: string[] = [];
          for (const key of streams) {
            const text = proc[key].slice(proc.readOffset[key]);
            const lines = args.tail
              ? text.split("\n").slice(-args.tail).join("\n")
              : text;
            parts.push(`[${key}] ${lines || "(no new output)"}`);
            proc.readOffset[key] = proc[key].length;
          }
          if (args.clear) {
            proc.stdout = "";
            proc.stderr = "";
            proc.readOffset = { stdout: 0, stderr: 0 };
          }
          parts.push(
            `status=${proc.status} exitCode=${proc.exitCode ?? "null"}`,
          );
          return ok(parts.join("\n"));
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "process_kill",
    {
      title: "Kill Process",
      description:
        "Terminate a tracked process. On Windows, force uses taskkill; on POSIX an optional signal is sent.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Process id returned by process_start"),
        force: z
          .boolean()
          .default(false)
          .describe("Force kill (taskkill /F on Windows, SIGKILL on POSIX)"),
        signal: z
          .string()
          .optional()
          .describe(
            "POSIX signal name such as SIGINT or SIGTERM (default SIGTERM)",
          ),
      }),
      annotations: ANNOTATIONS.destructive,
    },
    async (args) =>
      executeTool(
        "process_kill",
        args,
        async () => {
          const proc = findProcess(args.id);
          if (!proc) return fail(`Unknown process id: ${args.id}`);
          if (proc.status !== "running" || !proc.child) {
            return fail(`Process ${args.id} is already ${proc.status}.`);
          }

          if (IS_WINDOWS && args.force && proc.pid) {
            const result = await runCapture("taskkill", [
              "/PID",
              String(proc.pid),
              "/T",
              "/F",
            ]);
            if (result.code !== 0) {
              return fail(
                `taskkill failed: ${result.stderr.trim() || result.stdout.trim()}`,
              );
            }
          } else {
            let signal: NodeJS.Signals = args.force
              ? "SIGKILL"
              : ((args.signal ?? "SIGTERM") as NodeJS.Signals);
            if (IS_WINDOWS) signal = "SIGTERM";
            proc.child.kill(signal);
          }

          proc.status = "killed";
          auditAction("process_kill", context, {
            id: proc.id,
            pid: proc.pid,
            force: args.force,
          });
          return ok(
            `Sent ${args.force ? "force " : ""}kill to process ${args.id} (pid ${proc.pid ?? "?"}).`,
          );
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "process_list",
    {
      title: "List Processes",
      description:
        "List all processes started through process_start in this server.",
      inputSchema: z.object({
        runningOnly: z
          .boolean()
          .default(false)
          .describe("Only include processes that are still running"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "process_list",
        args,
        async () => {
          const items = [...state.processes.values()]
            .filter((p) => !args.runningOnly || p.status === "running")
            .map(summarize);
          return jsonResult({ count: items.length, processes: items });
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "process_info",
    {
      title: "Process Info",
      description:
        "Get details for a tracked process id, or query the operating system by PID.",
      inputSchema: z.object({
        id: z.string().optional().describe("Tracked process id"),
        pid: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Operating system PID"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "process_info",
        args,
        async () => {
          if (args.id) {
            const proc = findProcess(args.id);
            if (!proc) return fail(`Unknown process id: ${args.id}`);
            return jsonResult(summarize(proc));
          }
          if (args.pid) return queryOsProcess(args.pid);
          return fail("Provide either 'id' or 'pid'.");
        },
        context?.ip ?? null,
      ),
  );
}
