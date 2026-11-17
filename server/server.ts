import { defineServerEntry } from "nitro";
import { appConfig } from "~/config";

export default defineServerEntry({
  port: appConfig.port,
});
