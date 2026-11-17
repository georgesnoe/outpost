import { statfsSync } from "node:fs";
import {
  arch,
  cpus,
  endianness,
  freemem,
  hostname,
  loadavg,
  machine,
  platform,
  release,
  totalmem,
  type as osType,
  uptime,
  userInfo,
} from "node:os";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  ANNOTATIONS,
  IS_WINDOWS,
  auditAction,
  executeTool,
  fail,
  jsonResult,
  ok,
  powershell,
  runCapture,
  type ToolContext,
} from "~/tools/shared";
import { state } from "~/utils/state";

const SECRET_PATTERN =
  /(KEY|PASS|SECRET|TOKEN|CRED|COOKIE|AUTH|PRIVATE|SESSION|API|SALT|SIGNATURE)/i;

function maskValue(key: string, value: string, mask: boolean): string {
  if (mask && SECRET_PATTERN.test(key)) return "***";
  return value;
}

export function registerSystemTools(
  server: McpServer,
  context?: ToolContext,
): void {
  server.registerTool(
    "system_info",
    {
      title: "System Information",
      description:
        "Report host platform, OS release, CPU, memory, Node version, locale and timezone.",
      inputSchema: z.object({
        detailed: z
          .boolean()
          .default(false)
          .describe("Include raw OS command output (systeminfo / uname -a)"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "system_info",
        args,
        async () => {
          let user = "";
          try {
            user = userInfo().username;
          } catch {
            user = "unknown";
          }
          const info: Record<string, unknown> = {
            platform: platform(),
            osType: osType(),
            release: release(),
            arch: arch(),
            machine: machine(),
            hostname: hostname(),
            user,
            nodeVersion: process.version,
            nodeModules: process.versions.modules,
            cpus: cpus().length,
            cpuModel: cpus()[0]?.model ?? "unknown",
            totalMemoryBytes: totalmem(),
            osUptimeSeconds: uptime(),
            processUptimeSeconds: process.uptime(),
            locale: Intl.DateTimeFormat().resolvedOptions().locale,
            endianness: endianness(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            shell: IS_WINDOWS ? "PowerShell" : "bash",
          };

          if (args.detailed) {
            const [command, commandArgs] = IS_WINDOWS
              ? powershell("systeminfo")
              : ["uname", ["-a"]];
            const result = await runCapture(command, commandArgs, 15_000);
            info.raw = result.stdout.trim() || result.stderr.trim();
          }
          return jsonResult(info);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "system_resources",
    {
      title: "System Resources",
      description:
        "Report memory, CPU, load and disk usage plus this process's footprint.",
      inputSchema: z.object({
        path: z
          .string()
          .default(".")
          .describe("Path whose filesystem usage should be reported"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "system_resources",
        args,
        async () => {
          const free = freemem();
          const total = totalmem();
          const cpuList = cpus();
          const processMemory = process.memoryUsage();
          const processCpu = process.cpuUsage();

          let disk: Record<string, unknown> | null = null;
          try {
            const { resolve } = await import("node:path");
            const stats = statfsSync(resolve(args.path));
            const size = stats.blocks * stats.bsize;
            const available = stats.bavail * stats.bsize;
            disk = {
              path: resolve(args.path),
              totalBytes: size,
              availableBytes: available,
              usedBytes: size - available,
              usedPercent: size
                ? Math.round(((size - available) / size) * 1000) / 10
                : 0,
            };
          } catch (error) {
            disk = { error: (error as Error).message };
          }

          return jsonResult({
            memory: {
              totalBytes: total,
              freeBytes: free,
              usedBytes: total - free,
              usedPercent: total
                ? Math.round(((total - free) / total) * 1000) / 10
                : 0,
            },
            cpu: {
              count: cpuList.length,
              model: cpuList[0]?.model ?? "unknown",
              speedsMHz: cpuList.map((cpu) => cpu.speed),
              loadAverage: IS_WINDOWS ? [0, 0, 0] : loadavg(),
              loadAverageNote: IS_WINDOWS
                ? "unavailable on Windows"
                : undefined,
            },
            disk,
            process: {
              pid: process.pid,
              rssBytes: processMemory.rss,
              heapTotalBytes: processMemory.heapTotal,
              heapUsedBytes: processMemory.heapUsed,
              externalBytes: processMemory.external,
              cpuUserMicros: processCpu.user,
              cpuSystemMicros: processCpu.system,
            },
          });
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "environment_get",
    {
      title: "Read Environment Variables",
      description:
        "Read one environment variable or all of them. Secret-looking values are masked by default.",
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe("Variable name; omit to return all"),
        includeSecrets: z
          .boolean()
          .optional()
          .describe("Override secret masking"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "environment_get",
        args,
        async () => {
          const mask =
            args.includeSecrets ?? state.config.maskSecrets !== false;
          if (args.name) {
            const value = process.env[args.name];
            if (value === undefined)
              return fail(`Environment variable ${args.name} is not set.`);
            return ok(`${args.name}=${maskValue(args.name, value, mask)}`);
          }
          const entries = Object.entries(process.env)
            .filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            )
            .map(([key, value]) => [key, maskValue(key, value, mask)] as const)
            .sort((a, b) => a[0].localeCompare(b[0]));
          return jsonResult({
            masked: mask,
            count: entries.length,
            variables: Object.fromEntries(entries),
          });
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "config_get",
    {
      title: "Read Server Configuration",
      description:
        "Return the current mutable server configuration, or one key.",
      inputSchema: z.object({
        key: z
          .string()
          .optional()
          .describe("Configuration key; omit to return everything"),
      }),
      annotations: ANNOTATIONS.read,
    },
    async (args) =>
      executeTool(
        "config_get",
        args,
        async () => {
          if (args.key) {
            if (!(args.key in state.config))
              return fail(`Unknown config key: ${args.key}`);
            return jsonResult({ key: args.key, value: state.config[args.key] });
          }
          return jsonResult(state.config);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "config_update",
    {
      title: "Update Server Configuration",
      description:
        "Update one or more configuration keys. Known keys control limits, defaults and masking.",
      inputSchema: z.object({
        key: z.string().optional().describe("Key to update"),
        value: z.unknown().optional().describe("New value"),
        updates: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Multiple key/value pairs"),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "config_update",
        args,
        async () => {
          const updates =
            args.updates ?? (args.key ? { [args.key]: args.value } : {});
          if (Object.keys(updates).length === 0) {
            return fail("Provide key/value or updates.");
          }
          const changed: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(updates)) {
            const current = state.config[key];
            if (
              current !== undefined &&
              typeof current !== typeof value &&
              !Array.isArray(current)
            ) {
              return fail(
                `Config key ${key} expects ${Array.isArray(current) ? "an array" : typeof current}, got ${typeof value}.`,
              );
            }
            state.config[key] = value;
            changed[key] = value;
          }
          auditAction("config_update", context, { keys: Object.keys(changed) });
          return jsonResult({ updated: changed, config: state.config });
        },
        context?.ip ?? null,
      ),
  );
}
