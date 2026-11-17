import * as z from "zod";

/**
 * Shape of ~/.config/outpost/config.json.
 *
 * The file may be empty (`{}`) — every field has a default. Extra keys are
 * preserved so the file can also hold application-specific settings.
 */
export const appConfigSchema = z
  .object({
    /** Port the HTTP server listens on. */
    port: z.number().int().min(1).max(65535).default(65432),
    /** Better Auth signing secret. */
    secret: z.string().min(1).default("outpost-development-secret-replace-me"),
    /** Public origin used for OAuth callbacks and discovery. */
    url: z.string().url().default("http://localhost:65432"),
    /** SQLite file name, resolved inside ~/.config/outpost. */
    dbFileName: z.string().min(1).default("outpost.db"),
    /** Canonical MCP protected resource identifier. */
    mcpResourceUrl: z.string().url().default("https://api.example.com/mcp"),
    /** Optional application keys/tokens. */
    keys: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

export type AppConfig = z.infer<typeof appConfigSchema>;

/** Defaults used when config.json is empty or a field is omitted. */
export const DEFAULT_APP_CONFIG: AppConfig = appConfigSchema.parse({});

/** Environment variables that override values from config.json. */
export const ENV_OVERRIDES = {
  port: "PORT",
  secret: "BETTER_AUTH_SECRET",
  url: "BETTER_AUTH_URL",
  dbFileName: "DB_FILE_NAME",
  mcpResourceUrl: "MCP_RESOURCE_URL",
} as const;
