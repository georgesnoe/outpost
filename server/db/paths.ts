import "dotenv/config";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/** Directory used for all Outpost user data, under the current user's home. */
export const OUTPOST_CONFIG_DIR = join(homedir(), ".config", "outpost");

/** File name used when DB_FILE_NAME is not set. */
export const DEFAULT_DB_FILE_NAME = "outpost.db";

/**
 * Resolve the configured database file name.
 *
 * `DB_FILE_NAME` is normally just a file name and is resolved relative to
 * ~/.config/outpost. An absolute path is honoured as an explicit override,
 * but its file name is still kept inside the config directory when the value
 * would otherwise escape it (e.g. via `..` segments).
 */
export function resolveDbFileName(value?: string | null): string {
  const raw = (
    value ??
    process.env.DB_FILE_NAME ??
    DEFAULT_DB_FILE_NAME
  ).trim();
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
