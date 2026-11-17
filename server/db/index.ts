import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { BOOTSTRAP_SQL, PRAGMAS_SQL } from "~/db/bootstrap";
import { DB_FILE_NAME, ensureConfigDir } from "~/db/paths";
import { relations } from "~/db/schema";

ensureConfigDir();

/** The raw node:sqlite handle, useful for pragma statements and diagnostics. */
export const sqlite = new DatabaseSync(DB_FILE_NAME);
sqlite.exec(PRAGMAS_SQL);

// Create the tables on first run. Safe to repeat on every start.
sqlite.exec(BOOTSTRAP_SQL);

/** Drizzle client bound to the SQLite file under ~/.config/outpost. */
export const db = drizzle({ client: sqlite, relations });

export { DB_FILE_NAME, OUTPOST_CONFIG_DIR } from "~/db/paths";
