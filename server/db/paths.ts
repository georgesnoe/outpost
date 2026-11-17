import { mkdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { appConfig, OUTPOST_CONFIG_DIR } from "~/config";

export { OUTPOST_CONFIG_DIR };

/** File name used when the config does not specify one. */
export const DEFAULT_DB_FILE_NAME = appConfig.dbFileName;

/**
 * Resolve the configured database file name relative to the config directory.
 * An absolute path is honoured as an explicit override, but `..` segments that
 * escape the config directory fall back to the file's base name.
 */
export function resolveDbFileName(value?: string | null): string {
  const raw = (value ?? appConfig.dbFileName).trim();
  if (!raw) return join(OUTPOST_CONFIG_DIR, DEFAULT_DB_FILE_NAME);

  if (isAbsolute(raw)) return resolve(raw);

  const candidate = resolve(OUTPOST_CONFIG_DIR, raw);
  const fromConfigDir = relative(OUTPOST_CONFIG_DIR, candidate);
  if (fromConfigDir.startsWith("..") || isAbsolute(fromConfigDir)) {
    return join(OUTPOST_CONFIG_DIR, basename(raw));
  }
  return candidate;
}

/** Absolute path of the SQLite file used by Drizzle. */
export const DB_FILE_NAME = resolveDbFileName();

/** Ensures ~/.config/outpost exists and returns it. */
export function ensureConfigDir(): string {
  mkdirSync(OUTPOST_CONFIG_DIR, { recursive: true });
  return OUTPOST_CONFIG_DIR;
}
