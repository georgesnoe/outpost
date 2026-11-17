import { defineHandler } from "nitro";
import { auth } from "~/utils/auth";

/**
 * Better Auth mounts under /api/auth, while OAuth clients look for discovery
 * documents under the root /.well-known namespace (RFC 8414 / RFC 9728).
 *
 * Rewrite the authorization-server and OpenID discovery paths to the internal
 * /api/auth routes, and leave protected-resource paths untouched (the MCP
 * plugin matches those at the root itself).
 */
export default defineHandler(async (event) => {
  const original = new URL(event.req.url);
  const pathname = original.pathname.replace(/\/+$/, "");

  let path = pathname;
  if (pathname.startsWith("/.well-known/oauth-authorization-server")) {
    path = "/api/auth/.well-known/oauth-authorization-server";
  } else if (pathname.startsWith("/.well-known/openid-configuration")) {
    path = "/api/auth/.well-known/openid-configuration";
  }

  const url = new URL(`${path}${original.search}`, original.origin);
  return auth.handler(new Request(url, event.req));
});
