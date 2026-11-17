import { defineHandler } from "nitro";
import { auth } from "~/utils/auth";

/**
 * Better Auth mounts under /api/auth, but MCP clients discover protected
 * resource metadata at the root /.well-known namespace. Forward those requests
 * to the auth handler so the MCP plugin can serve them.
 */
export default defineHandler(async (event) => {
  return auth.handler(event.req);
});
