import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./server",
  errorHandler: "./server/error.ts",
});
