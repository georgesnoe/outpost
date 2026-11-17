import { defineHandler } from "nitro";
import { auth } from "~/utils/auth";

/** Better Auth mounts all of its endpoints under /api/auth. */
export default defineHandler(async (event) => {
  return auth.handler(event.req);
});
