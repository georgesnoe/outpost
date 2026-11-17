import { defineConfig } from "drizzle-kit";
import { DB_FILE_NAME } from "./server/db/paths";

export default defineConfig({
  dialect: "sqlite",
  schema: "./server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: DB_FILE_NAME,
  },
  verbose: true,
});
