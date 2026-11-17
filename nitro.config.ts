import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./server",
  errorHandler: "./server/error.ts",
  serverEntry: "./server/server.ts",
  // Embed the sign-in/consent pages in the server bundle so the compiled
  // single-file binary does not need .output/public at runtime.
  serveStatic: "inline",
});
