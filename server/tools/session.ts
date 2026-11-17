import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  ANNOTATIONS,
  PLATFORM,
  executeTool,
  jsonResult,
  type ToolContext,
} from "~/tools/shared";
import { state } from "~/utils/state";

export function registerSessionTools(
  server: McpServer,
  context?: ToolContext,
): void {
  server.registerTool(
    "session_info",
    {
      title: "Session Information",
      description:
        "Report server session identity, uptime and registered tool inventory.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.read,
    },
    async () =>
      executeTool(
        "session_info",
        {},
        async () =>
          jsonResult({
            sessionId: state.session.id,
            startedAt: new Date(state.session.startedAt).toISOString(),
            uptimeMs: Date.now() - state.session.startedAt,
            platform: PLATFORM,
            nodeVersion: process.version,
            pid: process.pid,
            registeredTools: [...state.registeredTools].sort(),
            trackedProcesses: state.processes.size,
            searchTasks: state.searches.size,
            recordedCalls: state.history.length,
          }),
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "usage_stats",
    {
      title: "Tool Usage Statistics",
      description:
        "Return call counts, success rates and timings for every tool used so far.",
      inputSchema: z.object({
        tool: z.string().optional().describe("Only report this tool"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "usage_stats",
        args,
        async () => {
          const entries = [...state.usage.entries()]
            .filter(([name]) => !args.tool || name === args.tool)
            .sort((a, b) => b[1].calls - a[1].calls)
            .map(([tool, usage]) => ({
              tool,
              calls: usage.calls,
              successes: usage.successes,
              failures: usage.failures,
              successRate:
                usage.calls === 0
                  ? 0
                  : Math.round((usage.successes / usage.calls) * 1000) / 10,
              totalMs: usage.totalMs,
              averageMs:
                usage.calls === 0 ? 0 : Math.round(usage.totalMs / usage.calls),
              lastCalledAt: usage.lastCalledAt,
            }));
          const totals = entries.reduce(
            (acc, entry) => ({
              calls: acc.calls + entry.calls,
              successes: acc.successes + entry.successes,
              failures: acc.failures + entry.failures,
            }),
            { calls: 0, successes: 0, failures: 0 },
          );
          return jsonResult({ totals, tools: entries });
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "tool_history",
    {
      title: "Tool Call History",
      description:
        "Return the most recent tool calls with arguments, duration and outcome.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .default(50)
          .describe("Number of records to return"),
        tool: z.string().optional().describe("Only include calls to this tool"),
        failuresOnly: z
          .boolean()
          .default(false)
          .describe("Only include failed calls"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "tool_history",
        args,
        async () => {
          const records = state.history
            .filter(
              (record) =>
                (!args.tool || record.tool === args.tool) &&
                (!args.failuresOnly || !record.success),
            )
            .slice(-args.limit)
            .reverse();
          return jsonResult({ count: records.length, records });
        },
        context?.ip ?? null,
      ),
  );
}
