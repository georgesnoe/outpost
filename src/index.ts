import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { registerExecTool } from "./tools/exec.ts"

const handler = createMcpHandler(() => {
  const mcpServer = new McpServer({ name: "outpost-server", version: "0.1.3" })
  registerExecTool(mcpServer)
  return mcpServer
})

const httpServer = Bun.serve({
  port: 65432,
  routes: {
    "/mcp": {
      POST: (req) => handler.fetch(req),
      GET: (req) => handler.fetch(req),
      DELETE: (req) => handler.fetch(req)
    }
  },
  fetch() {
    return new Response("Not Found", { status: 404 })
  },
  error() {
    return new Response("Error", { status: 500 })
  }
})

process.on("SIGTERM", () => {
  handler.close()
  httpServer.stop()
})
