import { defineErrorHandler } from "nitro";

export default defineErrorHandler((error, _event) => {
  return new Response(error.message, {
    status: error.status,
    headers: { "Content-Type": "text/json" },
  });
});
