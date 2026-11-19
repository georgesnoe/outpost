import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { appConfig } from "~/config";
import { db } from "~/db";
import { relations, tables } from "~/db/schema";

if (
  appConfig.secret.startsWith("outpost-development") &&
  process.env.NODE_ENV === "production"
) {
  console.warn(
    "[auth] using the development secret; set `secret` in config.json.",
  );
}

/** Public identifier of this MCP protected resource. */
export const MCP_RESOURCE = appConfig.mcpResourceUrl;

/** Better Auth instance using the Drizzle SQLite adapter and MCP OAuth provider. */
export const auth = betterAuth({
  appName: "Outpost",
  secret: appConfig.secret,
  baseURL: appConfig.url,
  // The browser-based consent flow runs on the public origin.
  trustedOrigins: [appConfig.url],
  disabledPaths: ["/token"],
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: { ...tables, relations },
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      loginPage: "/sign-in.html",
      consentPage: "/consent.html",
      signup: { page: "/sign-up.html" },
      resource: MCP_RESOURCE,
    }),
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
  ],
});

export type Auth = typeof auth;
