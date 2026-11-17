import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { defineHandler, HTTPError } from "nitro";
import { registerExecTool } from "~/tools/exec";
import { registerFileTools } from "~/tools/file";
import { registerMiscTools } from "~/tools/misc";
import { registerProcessTools } from "~/tools/process";
import { registerSearchTools } from "~/tools/search";
import { registerSessionTools } from "~/tools/session";
import { registerSystemTools } from "~/tools/system";

const handler = createMcpHandler((ctx) => {
  const mcpServer = new McpServer({ name: "outpost-server", version: "1.0.0" });
  const request = ctx.requestInfo;
  const context = { ip: clientIp(request, null) };

  registerExecTool(mcpServer, context);
  registerProcessTools(mcpServer, context);
  registerFileTools(mcpServer, context);
  registerSearchTools(mcpServer, context);
  registerSystemTools(mcpServer, context);
  registerSessionTools(mcpServer, context);
  registerMiscTools(mcpServer, context);

  return mcpServer;
});

const FORWARD_HEADERS = [
  "cf-connecting-ip", // Cloudflare tunnels
  "true-client-ip", // Cloudflare enterprise
  "fly-client-ip", // Fly.io
  "x-real-ip", // nginx
  "x-forwarded-for", // generic
];

/**
 * Carries the socket peer address along the request. The MCP transport
 * rebuilds the Request object, so a header survives where an object key
 * would not.
 */
const PEER_HEADER = "x-outpost-peer-ip";

/**
 * Best effort extraction of the caller's IP address. Behind a tunnel the
 * original address arrives in a forwarding header; a direct connection falls
 * back to the peer address of the socket.
 */
export function clientIp(
  request: Request | undefined,
  peerIp: string | null,
): string | null {
  if (request) {
    for (const header of FORWARD_HEADERS) {
      const value = request.headers.get(header);
      if (!value) continue;
      const first = value.split(",")[0]?.trim();
      if (first) return first;
    }
    const peer = request.headers.get(PEER_HEADER)?.trim();
    if (peer) return peer;
  }
  return peerIp;
}

/** Copies the request with the peer address attached. */
export async function withPeerIp(
  request: Request,
  peerIp: string | null,
): Promise<Request> {
  const headers = new Headers(request.headers);

  if (peerIp) {
    headers.set(PEER_HEADER, peerIp);
  }

  return new Request(request.url, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await request.arrayBuffer(),
    redirect: request.redirect,
  });
}

export default defineHandler(async (event) => {
  if (/^(GET|POST|DELETE)$/i.test(event.req.method)) {
    return handler.fetch(await withPeerIp(event.req, event.req.ip ?? null));
  }
  throw new HTTPError(
    JSON.stringify({
      statusCode: 405,
      statusMessage: "Method Not Allowed",
    }),
    { status: 405 },
  );
});
