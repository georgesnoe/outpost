import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  ANNOTATIONS,
  auditAction,
  configBool,
  configNumber,
  fail,
  executeTool,
  isHidden,
  jsonResult,
  ok,
  resolvePath,
  truncate,
  yieldToLoop,
  type ToolContext,
} from "~/tools/shared";

export type DirEntry = {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  modified?: string;
};

/** Shared directory walker used by directory_list / search tools. */
export async function walkEntries(options: {
  root: string;
  recursive: boolean;
  maxDepth: number;
  includeHidden: boolean;
  shouldStop?: () => boolean;
  onEntry: (
    entry: DirEntry,
    fullPath: string,
    depth: number,
  ) => void | Promise<void>;
}): Promise<{ scanned: number; stopped: boolean }> {
  let scanned = 0;
  let stopped = false;

  async function visit(dir: string, depth: number): Promise<void> {
    if (stopped || options.shouldStop?.()) {
      stopped = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      await options.onEntry({ name: dir, type: "other" }, dir, depth);
      return;
    }

    for (const entry of entries) {
      if (stopped || options.shouldStop?.()) {
        stopped = true;
        return;
      }
      if (!options.includeHidden && isHidden(entry.name)) continue;
      scanned += 1;
      if (scanned % 100 === 0) await yieldToLoop();

      const full = join(dir, entry.name);
      let type: DirEntry["type"] = "other";
      if (entry.isFile()) type = "file";
      else if (entry.isDirectory()) type = "directory";
      else if (entry.isSymbolicLink()) type = "symlink";

      let size: number | undefined;
      let modified: string | undefined;
      try {
        const info = await stat(full);
        size = info.size;
        modified = info.mtime.toISOString();
      } catch {
        // Broken symlink or vanished file — keep the entry without metadata.
      }

      const result = options.onEntry(
        { name: entry.name, type, size, modified },
        full,
        depth,
      );
      if (result instanceof Promise) await result;
      if (
        type === "directory" &&
        options.recursive &&
        depth < options.maxDepth
      ) {
        await visit(full, depth + 1);
      }
    }
  }

  await visit(options.root, 0);
  return { scanned, stopped };
}

function readEncoding(encoding: string): BufferEncoding {
  if (encoding === "base64" || encoding === "hex") return encoding;
  return "utf8";
}

export function registerFileTools(
  server: McpServer,
  context?: ToolContext,
): void {
  server.registerTool(
    "file_read",
    {
      title: "Read File",
      description:
        "Read a text file, optionally a line range. Supports utf8, base64 and hex.",
      inputSchema: z.object({
        path: z.string().min(1).describe("File path (absolute or relative)"),
        offset: z
          .number()
          .int()
          .nonnegative()
          .default(0)
          .describe("Zero-based line offset"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines"),
        encoding: z
          .enum(["utf8", "base64", "hex"])
          .default("utf8")
          .describe("Output encoding"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "file_read",
        args,
        async () => {
          const path = resolvePath(args.path);
          const max = configNumber("maxFileReadBytes", 5_000_000);
          const buffer = await readFile(path);
          if (buffer.length > max) {
            return fail(
              `File is ${buffer.length} bytes, above the ${max} byte read limit.`,
            );
          }
          if (args.encoding !== "utf8") {
            return ok(
              `[${path} | ${buffer.length} bytes | ${args.encoding}]\n${buffer.toString(readEncoding(args.encoding))}`,
            );
          }
          const allLines = buffer.toString("utf8").split("\n");
          const lines = allLines.slice(
            args.offset,
            args.limit ? args.offset + args.limit : undefined,
          );
          const header = `[${path} | lines ${args.offset + 1}-${args.offset + lines.length} of ${allLines.length} | ${buffer.length} bytes]`;
          return ok(
            `${header}\n${lines.join("\n")}${lines.length === 0 ? "(no lines in range)" : ""}`,
          );
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "file_read_many",
    {
      title: "Read Multiple Files",
      description: "Read several files in one call, each with a path header.",
      inputSchema: z.object({
        paths: z.array(z.string().min(1)).min(1).describe("Files to read"),
        maxBytesPerFile: z
          .number()
          .int()
          .positive()
          .default(200_000)
          .describe("Cap per file"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "file_read_many",
        args,
        async () => {
          const sections: string[] = [];
          for (const input of args.paths) {
            const path = resolvePath(input);
            try {
              const content = await readFile(path, "utf8");
              sections.push(
                `===== ${path} =====\n${truncate(content, args.maxBytesPerFile)}`,
              );
            } catch (error) {
              sections.push(
                `===== ${path} =====\n[error: ${(error as Error).message}]`,
              );
            }
          }
          return ok(sections.join("\n\n"));
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "file_write",
    {
      title: "Write File",
      description:
        "Create or overwrite a file, or append to it. Parent directories are created.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Destination file path"),
        content: z.string().describe("Content to write"),
        append: z
          .boolean()
          .default(false)
          .describe("Append instead of overwrite"),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "file_write",
        args,
        async () => {
          const path = resolvePath(args.path);
          await mkdir(dirname(path), { recursive: true });
          if (args.append) await appendFile(path, args.content, "utf8");
          else await writeFile(path, args.content, "utf8");
          const info = await stat(path);
          auditAction("file_write", context, {
            path,
            append: args.append,
            bytes: Buffer.byteLength(args.content),
          });
          return ok(
            `Wrote ${Buffer.byteLength(args.content)} bytes to ${path} (${info.size} total).`,
          );
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "file_edit",
    {
      title: "Edit File",
      description:
        "Replace exact strings in a file. Provide oldString/newString or an edits array applied in order.",
      inputSchema: z.object({
        path: z.string().min(1).describe("File to edit"),
        oldString: z.string().optional().describe("Exact text to replace"),
        newString: z.string().optional().describe("Replacement text"),
        replaceAll: z
          .boolean()
          .default(false)
          .describe("Replace every occurrence"),
        edits: z
          .array(
            z.object({
              oldString: z.string().min(1),
              newString: z.string(),
              replaceAll: z.boolean().default(false),
            }),
          )
          .optional()
          .describe("Multiple ordered edits"),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "file_edit",
        args,
        async () => {
          const edits =
            args.edits ??
            (args.oldString !== undefined
              ? [
                  {
                    oldString: args.oldString,
                    newString: args.newString ?? "",
                    replaceAll: args.replaceAll,
                  },
                ]
              : []);
          if (edits.length === 0)
            return fail("Provide oldString/newString or edits.");

          const path = resolvePath(args.path);
          let content = await readFile(path, "utf8");
          const before = Buffer.byteLength(content);

          for (let i = 0; i < edits.length; i += 1) {
            const edit = edits[i];
            const count = content.split(edit.oldString).length - 1;
            if (count === 0) {
              return fail(`Edit ${i + 1}: oldString not found in ${path}.`);
            }
            if (edit.replaceAll) {
              content = content.split(edit.oldString).join(edit.newString);
            } else {
              content = content.replace(edit.oldString, edit.newString);
            }
          }

          await writeFile(path, content, "utf8");
          auditAction("file_edit", context, { path, edits: edits.length });
          return ok(
            `Applied ${edits.length} edit(s) to ${path}. ${before} -> ${Buffer.byteLength(content)} bytes.`,
          );
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "file_info",
    {
      title: "File Info",
      description: "Return metadata for a file or directory.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to inspect"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "file_info",
        args,
        async () => {
          const path = resolvePath(args.path);
          const info = await stat(path);
          return jsonResult({
            path,
            type: info.isDirectory()
              ? "directory"
              : info.isFile()
                ? "file"
                : "other",
            size: info.size,
            created: info.birthtime.toISOString(),
            modified: info.mtime.toISOString(),
            accessed: info.atime.toISOString(),
            mode: `0${(info.mode & 0o777).toString(8)}`,
            sha256: info.isFile()
              ? createHash("sha256")
                  .update(await readFile(path))
                  .digest("hex")
              : undefined,
          });
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "file_move",
    {
      title: "Move or Rename File",
      description:
        "Move or rename a file/directory, with cross-device fallback and overwrite support.",
      inputSchema: z.object({
        source: z.string().min(1).describe("Source path"),
        destination: z.string().min(1).describe("Destination path"),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Replace an existing destination"),
      }),
      annotations: ANNOTATIONS.destructive,
    },
    async (args) =>
      executeTool(
        "file_move",
        args,
        async () => {
          const source = resolvePath(args.source);
          const destination = resolvePath(args.destination);
          await mkdir(dirname(destination), { recursive: true });

          try {
            const destInfo = await stat(destination);
            if (!args.overwrite)
              return fail(`Destination already exists: ${destination}`);
            await rm(destination, {
              recursive: destInfo.isDirectory(),
              force: true,
            });
          } catch {
            // Destination does not exist — expected.
          }

          try {
            await rename(source, destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EXDEV") {
              await copyFile(source, destination);
              await rm(source, { recursive: true, force: true });
            } else {
              throw error;
            }
          }
          auditAction("file_move", context, {
            source,
            destination,
            overwrite: args.overwrite,
          });
          return ok(`Moved ${source} -> ${destination}.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "file_delete",
    {
      title: "Delete File or Directory",
      description:
        "Remove a file or directory. Directories require recursive=true.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to remove"),
        recursive: z
          .boolean()
          .default(false)
          .describe("Remove directories and their contents"),
        force: z
          .boolean()
          .default(false)
          .describe("Do not error if the path is missing"),
      }),
      annotations: ANNOTATIONS.destructive,
    },
    async (args) =>
      executeTool(
        "file_delete",
        args,
        async () => {
          const path = resolvePath(args.path);
          await rm(path, { recursive: args.recursive, force: args.force });
          auditAction("file_delete", context, {
            path,
            recursive: args.recursive,
          });
          return ok(`Deleted ${path}.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "directory_create",
    {
      title: "Create Directory",
      description: "Create a directory, including missing parents.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Directory path"),
        recursive: z
          .boolean()
          .default(true)
          .describe("Create parent directories"),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "directory_create",
        args,
        async () => {
          const path = resolvePath(args.path);
          await mkdir(path, { recursive: args.recursive });
          auditAction("directory_create", context, { path });
          return ok(`Created directory ${path}.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "directory_list",
    {
      title: "List Directory",
      description:
        "List directory entries with type, size and modification time.",
      inputSchema: z.object({
        path: z.string().default(".").describe("Directory to list"),
        recursive: z
          .boolean()
          .default(false)
          .describe("Include subdirectories"),
        maxDepth: z
          .number()
          .int()
          .positive()
          .default(4)
          .describe("Maximum recursion depth"),
        includeHidden: z.boolean().optional().describe("Include dot-files"),
        long: z
          .boolean()
          .default(false)
          .describe("Show size and modification time"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "directory_list",
        args,
        async () => {
          const root = resolvePath(args.path);
          const includeHidden =
            args.includeHidden ?? configBool("includeHidden", false);
          const lines: string[] = [root];
          const maxEntries = 5_000;
          let count = 0;

          await walkEntries({
            root,
            recursive: args.recursive,
            maxDepth: args.maxDepth,
            includeHidden,
            onEntry: (entry, _full, depth) => {
              if (count >= maxEntries) return;
              count += 1;
              const indent = "  ".repeat(depth + 1);
              const suffix =
                entry.type === "directory"
                  ? "/"
                  : entry.type === "symlink"
                    ? " ->"
                    : "";
              const meta = args.long
                ? `  ${String(entry.size ?? "-").padStart(10)}  ${entry.modified ?? ""}`
                : "";
              lines.push(`${indent}${entry.name}${suffix}${meta}`);
            },
          });
          if (count >= maxEntries)
            lines.push(`... (stopped after ${maxEntries} entries)`);
          lines.push(`(${count} entries)`);
          return ok(lines.join("\n"));
        },
        context?.ip ?? null,
      ),
  );
}
