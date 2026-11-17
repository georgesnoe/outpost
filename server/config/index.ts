import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appConfigSchema,
  DEFAULT_APP_CONFIG,
  ENV_OVERRIDES,
  type AppConfig,
} from "./schema";

/** Directory that holds the database and the config file. */
export const OUTPOST_CONFIG_DIR = join(homedir(), ".config", "outpost");

/** Path of the user-editable config file. */
export const CONFIG_PATH = join(OUTPOST_CONFIG_DIR, "config.json");

/**
 * Ensures the config directory and file exist. A missing file is created as
 * `{}` (all defaults) — environment variables are deliberately not written
 * into it.
 */
export function ensureConfigFile(): string {
  mkdirSync(OUTPOST_CONFIG_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, `${JSON.stringify({}, null, 2)}\n`, "utf8");
  }
  return CONFIG_PATH;
}

/** Reads config.json, applies defaults and then environment overrides. */
export function loadAppConfig(): AppConfig {
  ensureConfigFile();

  let raw: unknown = {};
  try {
    const text = readFileSync(CONFIG_PATH, "utf8").trim();
    if (text) raw = JSON.parse(text);
  } catch (error) {
    console.warn(
      `[config] could not parse ${CONFIG_PATH}: ${(error as Error).message}`,
    );
  }

  const parsed = appConfigSchema.parse(raw ?? {});

  const overrides: Partial<AppConfig> = {};
  const port = Number(process.env[ENV_OVERRIDES.port]);
  if (Number.isInteger(port) && port > 0 && port <= 65535)
    overrides.port = port;

  const secret = process.env[ENV_OVERRIDES.secret];
  if (secret) overrides.secret = secret;

  const url = process.env[ENV_OVERRIDES.url];
  if (url) overrides.url = url;

  const dbFileName = process.env[ENV_OVERRIDES.dbFileName];
  if (dbFileName) overrides.dbFileName = dbFileName;

  const mcpResourceUrl = process.env[ENV_OVERRIDES.mcpResourceUrl];
  if (mcpResourceUrl) overrides.mcpResourceUrl = mcpResourceUrl;

  return appConfigSchema.parse({ ...parsed, ...overrides });
}

/** Resolved configuration for the current process. */
export const appConfig = loadAppConfig();

/** Reloads the config file (useful after editing it at runtime). */
export function reloadAppConfig(): AppConfig {
  const reloaded = loadAppConfig();
  Object.assign(appConfig, reloaded);
  return appConfig;
}

export { appConfigSchema, DEFAULT_APP_CONFIG, type AppConfig };
