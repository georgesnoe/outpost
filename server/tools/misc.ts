import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  ANNOTATIONS,
  IS_MACOS,
  IS_WINDOWS,
  auditAction,
  executeTool,
  fail,
  isHidden,
  jsonResult,
  ok,
  powershell,
  psQuote,
  resolvePath,
  runCapture,
  runWithInput,
  type ToolContext,
} from "~/tools/shared";

type DiffOp = { type: "equal" | "del" | "add"; text: string };

/** Line-level LCS diff, bounded to keep the dynamic-programming table small. */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if (j < m && (i === n || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      ops.push({ type: "add", text: b[j] ?? "" });
      j += 1;
    } else {
      ops.push({ type: "del", text: a[i] ?? "" });
      i += 1;
    }
  }
  return ops;
}

function renderUnified(
  ops: DiffOp[],
  context: number,
  oldName: string,
  newName: string,
): string {
  let aLine = 1;
  let bLine = 1;
  const annotated = ops.map((op) => {
    const entry = { op, a: 0, b: 0 };
    if (op.type === "equal") {
      entry.a = aLine;
      entry.b = bLine;
      aLine += 1;
      bLine += 1;
    } else if (op.type === "del") {
      entry.a = aLine;
      aLine += 1;
    } else {
      entry.b = bLine;
      bLine += 1;
    }
    return entry;
  });

  const changes = annotated
    .map((entry, index) => (entry.op.type === "equal" ? -1 : index))
    .filter((index) => index >= 0);
  if (changes.length === 0) return "No differences.";

  const ranges: { start: number; end: number }[] = [];
  for (const index of changes) {
    const start = Math.max(0, index - context);
    const end = Math.min(annotated.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const lines = [`--- ${oldName}`, `+++ ${newName}`];
  for (const range of ranges) {
    const slice = annotated.slice(range.start, range.end);
    const aNumbers = slice.map((entry) => entry.a).filter((value) => value > 0);
    const bNumbers = slice.map((entry) => entry.b).filter((value) => value > 0);
    const aStart = aNumbers[0] ?? 1;
    const bStart = bNumbers[0] ?? 1;
    lines.push(
      `@@ -${aStart},${aNumbers.length || 0} +${bStart},${bNumbers.length || 0} @@`,
    );
    for (const entry of slice) {
      const prefix =
        entry.op.type === "equal" ? " " : entry.op.type === "del" ? "-" : "+";
      lines.push(`${prefix}${entry.op.text}`);
    }
  }
  return lines.join("\n");
}

function appleQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function registerMiscTools(
  server: McpServer,
  context?: ToolContext,
): void {
  server.registerTool(
    "file_diff",
    {
      title: "File Diff",
      description:
        "Compare two files or two literal strings and produce a unified diff. Max 2000 lines per side.",
      inputSchema: z.object({
        pathA: z.string().optional().describe("First file path"),
        pathB: z.string().optional().describe("Second file path"),
        a: z
          .string()
          .optional()
          .describe("First literal string (used when pathA is absent)"),
        b: z
          .string()
          .optional()
          .describe("Second literal string (used when pathB is absent)"),
        context: z
          .number()
          .int()
          .nonnegative()
          .default(3)
          .describe("Context lines per hunk"),
        maxLines: z
          .number()
          .int()
          .positive()
          .default(2000)
          .describe("Max lines per side"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "file_diff",
        args,
        async () => {
          const load = async (
            path: string | undefined,
            literal: string | undefined,
            label: string,
          ) => {
            if (path)
              return {
                text: await readFile(resolvePath(path), "utf8"),
                label: path,
              };
            if (literal !== undefined) return { text: literal, label };
            return null;
          };
          const left = await load(args.pathA, args.a, "a");
          const right = await load(args.pathB, args.b, "b");
          if (!left || !right) {
            return fail(
              "Provide pathA and pathB, or a and b (or a mix of paths and literals).",
            );
          }
          const aLines = left.text.split("\n").slice(0, args.maxLines);
          const bLines = right.text.split("\n").slice(0, args.maxLines);
          return ok(
            renderUnified(
              diffLines(aLines, bLines),
              args.context,
              left.label,
              right.label,
            ),
          );
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "directory_tree",
    {
      title: "Directory Tree",
      description:
        "Render a directory as a Unicode tree with optional depth limit.",
      inputSchema: z.object({
        path: z.string().default(".").describe("Root directory"),
        maxDepth: z
          .number()
          .int()
          .positive()
          .default(4)
          .describe("Maximum depth"),
        includeHidden: z.boolean().default(false).describe("Include dot-files"),
        maxEntries: z
          .number()
          .int()
          .positive()
          .default(1000)
          .describe("Entry cap"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "directory_tree",
        args,
        async () => {
          const root = resolvePath(args.path);
          const lines: string[] = [root];
          let count = 0;

          async function walk(
            dir: string,
            prefix: string,
            depth: number,
          ): Promise<void> {
            if (count >= args.maxEntries || depth > args.maxDepth) return;
            let entries;
            try {
              entries = await readdir(dir, { withFileTypes: true });
            } catch {
              return;
            }
            const visible = entries.filter(
              (entry) => args.includeHidden || !isHidden(entry.name),
            );
            for (let i = 0; i < visible.length; i += 1) {
              if (count >= args.maxEntries) return;
              const entry = visible[i]!;
              const last = i === visible.length - 1;
              const connector = last ? "└── " : "├── ";
              lines.push(
                `${prefix}${connector}${entry.name}${entry.isDirectory() ? "/" : ""}`,
              );
              count += 1;
              if (entry.isDirectory()) {
                await walk(
                  join(dir, entry.name),
                  prefix + (last ? "    " : "│   "),
                  depth + 1,
                );
              }
            }
          }

          await walk(root, "", 0);
          if (count >= args.maxEntries)
            lines.push(`... (stopped after ${args.maxEntries} entries)`);
          lines.push(`(${count} entries)`);
          return ok(lines.join("\n"));
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "clipboard_read",
    {
      title: "Read Clipboard",
      description:
        "Read the system clipboard (Get-Clipboard on Windows, pbpaste on macOS, xclip/wl-paste on Linux).",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.read,
    },
    async () =>
      executeTool(
        "clipboard_read",
        {},
        async () => {
          const attempts: [string, string[]][] = IS_WINDOWS
            ? [powershell("Get-Clipboard -Raw")]
            : IS_MACOS
              ? [["pbpaste", []]]
              : [
                  ["xclip", ["-selection", "clipboard", "-o"]],
                  ["wl-paste", []],
                  ["xsel", ["--clipboard", "--output"]],
                ];
          const errors: string[] = [];
          for (const [command, commandArgs] of attempts) {
            const result = await runCapture(
              command,
              commandArgs,
              5_000,
              1_000_000,
            );
            if (result.code === 0) {
              return ok(
                result.stdout.replace(/\r\n/g, "\n") || "(clipboard is empty)",
              );
            }
            errors.push(
              `${command}: ${result.stderr.trim() || `exit ${result.code}`}`,
            );
          }
          return fail(
            `No working clipboard utility found. ${errors.join("; ")}`,
          );
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "clipboard_write",
    {
      title: "Write Clipboard",
      description:
        "Write text to the system clipboard (Set-Clipboard on Windows, pbcopy on macOS, xclip/wl-copy on Linux).",
      inputSchema: z.object({
        text: z.string().describe("Text to place on the clipboard"),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "clipboard_write",
        args,
        async () => {
          const attempts: [string, string[]][] = IS_WINDOWS
            ? [
                powershell(
                  "$t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t",
                ),
              ]
            : IS_MACOS
              ? [["pbcopy", []]]
              : [
                  ["xclip", ["-selection", "clipboard"]],
                  ["wl-copy", []],
                  ["xsel", ["--clipboard", "--input"]],
                ];
          const errors: string[] = [];
          for (const [command, commandArgs] of attempts) {
            const result = await runWithInput(
              command,
              commandArgs,
              args.text,
              5_000,
            );
            if (result.code === 0) {
              auditAction("clipboard_write", context, {
                bytes: Buffer.byteLength(args.text),
              });
              return ok(
                `Copied ${Buffer.byteLength(args.text)} bytes to the clipboard.`,
              );
            }
            errors.push(
              `${command}: ${result.stderr.trim() || `exit ${result.code}`}`,
            );
          }
          return fail(
            `No working clipboard utility found. ${errors.join("; ")}`,
          );
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "system_notification",
    {
      title: "Show Notification",
      description:
        "Display a desktop notification (toast on Windows, osascript on macOS, notify-send on Linux).",
      inputSchema: z.object({
        title: z.string().default("Outpost").describe("Notification title"),
        message: z.string().min(1).describe("Notification body"),
      }),
      annotations: ANNOTATIONS.open,
    },
    async (args) =>
      executeTool(
        "system_notification",
        args,
        async () => {
          let command: string;
          let commandArgs: string[];

          if (IS_WINDOWS) {
            const script =
              `[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]; ` +
              `$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(` +
              `[Windows.UI.Notifications.ToastTemplateType]::ToastText02); ` +
              `$nodes = $t.GetElementsByTagName('text'); ` +
              `$nodes.Item(0).AppendChild($t.CreateTextNode(${psQuote(args.title)})) | Out-Null; ` +
              `$nodes.Item(1).AppendChild($t.CreateTextNode(${psQuote(args.message)})) | Out-Null; ` +
              `$toast = [Windows.UI.Notifications.ToastNotification]::new($t); ` +
              `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Outpost').Show($toast)`;
            [command, commandArgs] = powershell(script);
          } else if (IS_MACOS) {
            command = "osascript";
            commandArgs = [
              "-e",
              `display notification ${appleQuote(args.message)} with title ${appleQuote(args.title)}`,
            ];
          } else {
            command = "notify-send";
            commandArgs = [args.title, args.message];
          }

          const result = await runCapture(command, commandArgs, 10_000);
          if (result.code !== 0 && !IS_WINDOWS) {
            return fail(
              `Failed to show notification: ${result.stderr.trim() || `exit ${result.code}`}`,
            );
          }
          auditAction("system_notification", context, { title: args.title });
          return ok(`Notification requested via ${command}.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "port_list",
    {
      title: "List Listening Ports",
      description:
        "List listening TCP/UDP ports with owning PIDs. Uses netstat on Windows, lsof on macOS and ss on Linux.",
      inputSchema: z.object({
        protocol: z
          .enum(["tcp", "udp", "both"])
          .default("tcp")
          .describe("Protocol filter"),
        listeningOnly: z
          .boolean()
          .default(true)
          .describe("Only return sockets in a listening state"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "port_list",
        args,
        async () => {
          let command: string;
          let commandArgs: string[];
          let parser: "netstat" | "lsof" | "ss";

          if (IS_WINDOWS) {
            command = "netstat";
            commandArgs = [
              "-ano",
              "-p",
              args.protocol === "both" ? "TCP" : args.protocol.toUpperCase(),
            ];
            parser = "netstat";
          } else if (IS_MACOS) {
            command = "lsof";
            commandArgs = [
              "-nP",
              `-i${args.protocol === "both" ? "" : args.protocol.toUpperCase()}`,
            ];
            parser = "lsof";
          } else {
            command = "ss";
            commandArgs = [
              "-H",
              args.protocol === "tcp"
                ? "-ltn"
                : args.protocol === "udp"
                  ? "-lun"
                  : "-lunp",
            ];
            if (args.protocol === "tcp") commandArgs.push("-p");
            parser = "ss";
          }

          const result = await runCapture(command, commandArgs, 10_000);
          if (result.code !== 0) {
            return fail(
              `Failed to list ports: ${result.stderr.trim() || `exit ${result.code}`}`,
            );
          }
          const raw = result.stdout.trim();
          const ports: Record<string, unknown>[] = [];

          for (const line of raw.split(/\r?\n/)) {
            if (parser === "netstat") {
              const parts = line.trim().split(/\s+/);
              if (!/^(TCP|UDP)$/i.test(parts[0] ?? "")) continue;
              const state = parts[3] ?? "";
              if (args.listeningOnly && state !== "LISTENING") continue;
              const addressPort = parts[1] ?? "";
              const splitAt = addressPort.lastIndexOf(":");
              ports.push({
                protocol: parts[0]!.toUpperCase(),
                address: addressPort.slice(0, splitAt),
                port: Number(addressPort.slice(splitAt + 1)),
                state,
                pid: Number(parts[4]) || null,
              });
            } else if (parser === "ss") {
              const parts = line.trim().split(/\s+/);
              const local = parts[3] ?? "";
              const splitAt = local.lastIndexOf(":");
              if (!local) continue;
              ports.push({
                protocol:
                  args.protocol === "both"
                    ? parts[0] === "UNCONN"
                      ? "udp"
                      : "tcp"
                    : args.protocol,
                address: local.slice(0, splitAt),
                port: Number(local.slice(splitAt + 1)),
                state: parts[0] ?? "",
                pid: Number(line.match(/pid=(\d+)/)?.[1] ?? 0) || null,
                process: line.match(/\("([^"]+)"/)?.[1] ?? null,
              });
            }
          }

          return jsonResult({
            command: `${command} ${commandArgs.join(" ")}`.trim(),
            count:
              parser === "lsof"
                ? raw.split(/\r?\n/).filter(Boolean).length
                : ports.length,
            ports,
            raw: parser === "lsof" || ports.length === 0 ? raw : undefined,
          });
        },
        context?.ip ?? null,
      ),
  );
}
