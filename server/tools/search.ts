import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { walkEntries } from "~/tools/file";
import {
  ANNOTATIONS,
  configBool,
  configNumber,
  fail,
  executeTool,
  globToRegExp,
  jsonResult,
  resolvePath,
  type ToolContext,
} from "~/tools/shared";
import { nextSearchId, state, type SearchTask } from "~/utils/state";

type CommonSearchArgs = {
  path: string;
  recursive: boolean;
  maxDepth: number;
  includeHidden?: boolean;
  maxResults?: number;
  wait?: boolean;
  timeout?: number;
};

function createTask(
  kind: SearchTask["kind"],
  query: string,
  maxResults: number,
): SearchTask {
  const limit = configNumber("maxSearches", 32);
  if (state.searches.size >= limit) {
    const oldest = [...state.searches.values()].sort(
      (a, b) => a.startedAt - b.startedAt,
    )[0];
    if (oldest) {
      oldest.controller.abort();
      state.searches.delete(oldest.id);
    }
  }
  const task: SearchTask = {
    id: nextSearchId(),
    kind,
    query,
    status: "running",
    startedAt: Date.now(),
    scanned: 0,
    matches: [],
    maxResults,
    controller: new AbortController(),
  };
  state.searches.set(task.id, task);
  return task;
}

function addMatch(task: SearchTask, match: Record<string, unknown>): boolean {
  if (task.matches.length >= task.maxResults) return false;
  task.matches.push(match);
  return true;
}

function taskSummary(
  task: SearchTask,
  includeMatches: boolean,
  maxMatches: number,
) {
  return {
    id: task.id,
    kind: task.kind,
    query: task.query,
    status: task.status,
    startedAt: new Date(task.startedAt).toISOString(),
    finishedAt: task.finishedAt
      ? new Date(task.finishedAt).toISOString()
      : null,
    elapsedMs: (task.finishedAt ?? Date.now()) - task.startedAt,
    scanned: task.scanned,
    matchCount: task.matches.length,
    error: task.error,
    matches: includeMatches ? task.matches.slice(0, maxMatches) : undefined,
  };
}

async function waitForTask(task: SearchTask, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (task.status === "running" && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function startFileSearch(
  task: SearchTask,
  args: CommonSearchArgs & {
    pattern: string;
    type: string;
    caseSensitive: boolean;
  },
  root: string,
): Promise<void> {
  const matcher = globToRegExp(args.pattern || "*", args.caseSensitive);
  const includeHidden =
    args.includeHidden ?? configBool("includeHidden", false);

  try {
    const result = await walkEntries({
      root,
      recursive: args.recursive,
      maxDepth: args.maxDepth,
      includeHidden,
      shouldStop: () =>
        task.controller.signal.aborted ||
        task.matches.length >= task.maxResults,
      onEntry: (entry, fullPath) => {
        task.scanned += 1;
        if (entry.type === "other" && entry.name === fullPath) return; // unreadable dir
        if (args.type !== "both" && entry.type !== args.type) return;
        const relativePath = relative(root, fullPath) || ".";
        if (!matcher.test(entry.name) && !matcher.test(relativePath)) return;
        addMatch(task, {
          name: entry.name,
          path: fullPath,
          relativePath,
          type: entry.type,
          size: entry.size,
          modified: entry.modified,
        });
      },
    });
    if (result.stopped && task.controller.signal.aborted)
      task.status = "stopped";
    else task.status = "completed";
  } catch (error) {
    task.status = "error";
    task.error = (error as Error).message;
  } finally {
    task.finishedAt = Date.now();
  }
}

async function startContentSearch(
  task: SearchTask,
  args: CommonSearchArgs & {
    query: string;
    isRegex: boolean;
    caseSensitive: boolean;
    filePattern: string;
    contextLines: number;
    maxFileSize: number;
  },
  root: string,
): Promise<void> {
  const includeHidden =
    args.includeHidden ?? configBool("includeHidden", false);
  const fileMatcher = globToRegExp(args.filePattern || "*", args.caseSensitive);
  let matcher: RegExp;
  try {
    const source = args.isRegex
      ? args.query
      : args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    matcher = new RegExp(source, args.caseSensitive ? "g" : "gi");
  } catch (error) {
    task.status = "error";
    task.error = `Invalid pattern: ${(error as Error).message}`;
    task.finishedAt = Date.now();
    return;
  }

  try {
    await walkEntries({
      root,
      recursive: args.recursive,
      maxDepth: args.maxDepth,
      includeHidden,
      shouldStop: () =>
        task.controller.signal.aborted ||
        task.matches.length >= task.maxResults,
      onEntry: async (entry, fullPath) => {
        task.scanned += 1;
        if (entry.type !== "file") return;
        if (!fileMatcher.test(entry.name)) return;
        if ((entry.size ?? 0) > args.maxFileSize) return;

        let text: string;
        try {
          text = await readFile(fullPath, "utf8");
        } catch {
          return;
        }
        if (text.includes("\u0000")) return; // skip binaries

        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (
            task.controller.signal.aborted ||
            task.matches.length >= task.maxResults
          )
            return;
          matcher.lastIndex = 0;
          if (!matcher.test(lines[i] ?? "")) continue;
          const from = Math.max(0, i - args.contextLines);
          const to = Math.min(lines.length - 1, i + args.contextLines);
          const context: string[] = [];
          for (let j = from; j <= to; j += 1) {
            context.push(`${j === i ? ">" : " "} ${j + 1}: ${lines[j] ?? ""}`);
          }
          if (
            !addMatch(task, {
              path: fullPath,
              line: i + 1,
              column: ((lines[i] ?? "").match(matcher)?.index ?? 0) + 1,
              text: (lines[i] ?? "").trim(),
              context: context.join("\n"),
            })
          ) {
            return;
          }
        }
      },
    });
    if (task.controller.signal.aborted) task.status = "stopped";
    else task.status = "completed";
  } catch (error) {
    task.status = "error";
    task.error = (error as Error).message;
  } finally {
    task.finishedAt = Date.now();
  }
}

export function registerSearchTools(
  server: McpServer,
  context?: ToolContext,
): void {
  server.registerTool(
    "search_files",
    {
      title: "Search Files",
      description:
        "Find files/directories by glob pattern. Runs in the background; returns a task id unless wait is set.",
      inputSchema: z.object({
        path: z.string().default(".").describe("Root directory"),
        pattern: z.string().default("*").describe("Glob pattern, e.g. **/*.ts"),
        type: z
          .enum(["file", "directory", "both"])
          .default("file")
          .describe("Entry type"),
        recursive: z
          .boolean()
          .default(true)
          .describe("Recurse into subdirectories"),
        maxDepth: z
          .number()
          .int()
          .positive()
          .default(16)
          .describe("Maximum recursion depth"),
        includeHidden: z.boolean().optional().describe("Include dot-files"),
        caseSensitive: z
          .boolean()
          .default(false)
          .describe("Case-sensitive matching"),
        maxResults: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Result cap"),
        wait: z
          .boolean()
          .default(false)
          .describe("Wait for completion before returning"),
        timeout: z
          .number()
          .int()
          .positive()
          .default(10_000)
          .describe("Wait timeout in ms"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "search_files",
        args,
        async () => {
          const root = resolvePath(args.path);
          const maxResults =
            args.maxResults ?? configNumber("maxSearchResults", 1_000);
          const task = createTask("files", args.pattern, maxResults);
          void startFileSearch(task, args, root);
          if (args.wait) await waitForTask(task, args.timeout);
          return jsonResult(taskSummary(task, true, 200));
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "search_content",
    {
      title: "Search File Contents",
      description:
        "Search file contents for a string or regex. Runs in the background; returns a task id unless wait is set.",
      inputSchema: z.object({
        path: z.string().default(".").describe("Root directory"),
        query: z.string().min(1).describe("Text or regular expression to find"),
        isRegex: z
          .boolean()
          .default(false)
          .describe("Treat query as a regular expression"),
        caseSensitive: z
          .boolean()
          .default(false)
          .describe("Case-sensitive matching"),
        filePattern: z
          .string()
          .default("*")
          .describe("Glob applied to file names"),
        recursive: z
          .boolean()
          .default(true)
          .describe("Recurse into subdirectories"),
        maxDepth: z
          .number()
          .int()
          .positive()
          .default(16)
          .describe("Maximum recursion depth"),
        includeHidden: z.boolean().optional().describe("Include dot-files"),
        contextLines: z
          .number()
          .int()
          .nonnegative()
          .default(1)
          .describe("Context lines around matches"),
        maxFileSize: z
          .number()
          .int()
          .positive()
          .default(1_000_000)
          .describe("Skip larger files"),
        maxResults: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Result cap"),
        wait: z
          .boolean()
          .default(false)
          .describe("Wait for completion before returning"),
        timeout: z
          .number()
          .int()
          .positive()
          .default(10_000)
          .describe("Wait timeout in ms"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "search_content",
        args,
        async () => {
          const root = resolvePath(args.path);
          const maxResults =
            args.maxResults ?? configNumber("maxSearchResults", 1_000);
          const task = createTask("content", args.query, maxResults);
          void startContentSearch(task, args, root);
          if (args.wait) await waitForTask(task, args.timeout);
          return jsonResult(taskSummary(task, true, 100));
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "search_status",
    {
      title: "Search Status",
      description:
        "Report progress and partial results for one or all background searches.",
      inputSchema: z.object({
        taskId: z
          .string()
          .optional()
          .describe("Task id; omit to list all tasks"),
        includeMatches: z
          .boolean()
          .default(true)
          .describe("Include matched items in the response"),
        maxMatches: z
          .number()
          .int()
          .positive()
          .default(50)
          .describe("Maximum matches to include"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "search_status",
        args,
        async () => {
          if (args.taskId) {
            const task = state.searches.get(args.taskId);
            if (!task) return fail(`Unknown search task: ${args.taskId}`);
            return jsonResult(
              taskSummary(task, args.includeMatches, args.maxMatches),
            );
          }
          const tasks = [...state.searches.values()].map((task) =>
            taskSummary(task, args.includeMatches, args.maxMatches),
          );
          return jsonResult({ count: tasks.length, tasks });
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "search_stop",
    {
      title: "Stop Search",
      description: "Cancel a running background search.",
      inputSchema: z.object({
        taskId: z.string().min(1).describe("Task id returned by a search tool"),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "search_stop",
        args,
        async () => {
          const task = state.searches.get(args.taskId);
          if (!task) return fail(`Unknown search task: ${args.taskId}`);
          if (task.status === "running") {
            task.controller.abort();
            task.status = "stopped";
            task.finishedAt = Date.now();
          }
          return jsonResult(taskSummary(task, true, 50));
        },
        context?.ip ?? null,
      ),
  );
}
