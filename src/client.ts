/**
 * Headers a reverse proxy or tunnel uses to forward the original client IP.
 * Ordered by how much we trust them.
 */
const FORWARD_HEADERS = [
  "cf-connecting-ip", // Cloudflare tunnels
  "true-client-ip", // Cloudflare enterprise
  "fly-client-ip", // Fly.io
  "x-real-ip", // nginx
  "x-forwarded-for" // generic
]

/**
 * Carries the socket peer address along the request. The MCP transport
 * rebuilds the Request object, so a header survives where an object key
 * would not.
 */
const PEER_HEADER = "x-outpost-peer-ip"

/** Copies the request with the peer address attached. */
export function withPeerIp(request: Request, peerIp: string | null): Request {
  const headers = new Headers(request.headers)
  if (peerIp) headers.set(PEER_HEADER, peerIp)
  return new Request(request, { headers })
}

/**
 * Best effort extraction of the caller's IP address. Behind a tunnel the
 * original address arrives in a forwarding header; a direct connection falls
 * back to the peer address of the socket.
 */
export function clientIp(
  request: Request | undefined,
  peerIp: string | null
): string | null {
  if (request) {
    for (const header of FORWARD_HEADERS) {
      const value = request.headers.get(header)
      if (!value) continue
      const first = value.split(",")[0]?.trim()
      if (first) return first
    }
    const peer = request.headers.get(PEER_HEADER)?.trim()
    if (peer) return peer
  }
  return peerIp
}
