import { defineServerEntry } from "nitro";

const port = Number(process.env.PORT ?? process.env.NITRO_PORT ?? 65432);

export default defineServerEntry({
  port: Number.isFinite(port) ? port : 65432,
});
