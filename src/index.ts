import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { registerExecTool } from "./tools/exec.ts"
import { clientIp, withPeerIp } from "./client.ts"
import { audit } from "./log.ts"

const handler = createMcpHandler((ctx) => {
  const mcpServer = new McpServer({ name: "outpost-server", version: "1.0.0" })
  const request = ctx.requestInfo
  registerExecTool(mcpServer, { ip: clientIp(request, null) })
  return mcpServer
})

const httpServer = Bun.serve({
  port: 65432,
  routes: {
    "/mcp": {
      POST: (req, server) =>
        handler.fetch(withPeerIp(req, server.requestIP(req)?.address ?? null)),
      GET: (req, server) =>
        handler.fetch(withPeerIp(req, server.requestIP(req)?.address ?? null)),
      DELETE: (req, server) =>
        handler.fetch(withPeerIp(req, server.requestIP(req)?.address ?? null))
    }
  },
  fetch() {
    return new Response("Not Found", { status: 404 })
  },
  error() {
    return new Response("Error", { status: 500 })
  }
})

audit({
  event: "server",
  actor: "outpost",
  ip: null,
  status: "listening",
  port: httpServer.port
})

process.on("SIGTERM", () => {
  audit({ event: "server", actor: "outpost", ip: null, status: "stopping" })
  handler.close()
  httpServer.stop()
})
