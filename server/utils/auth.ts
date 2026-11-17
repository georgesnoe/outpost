import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { db } from "~/db";
import { relations, tables } from "~/db/schema";

const DEV_SECRET = "outpost-development-secret-replace-with-BETTER_AUTH_SECRET";

if (!process.env.BETTER_AUTH_SECRET && process.env.NODE_ENV === "production") {
  console.warn(
    "[auth] BETTER_AUTH_SECRET is not set; set it before deploying.",
  );
}

/** Public identifier of this MCP protected resource. */
export const MCP_RESOURCE =
  process.env.MCP_RESOURCE_URL ?? "http://api.example.com/mcp";

/** Better Auth instance using the Drizzle SQLite adapter and MCP OAuth provider. */
export const auth = betterAuth({
  appName: "Outpost",
  secret: process.env.BETTER_AUTH_SECRET || DEV_SECRET,
  ...(process.env.BETTER_AUTH_URL
    ? {
        baseURL: process.env.BETTER_AUTH_URL,
        // The browser-based consent flow runs on the public tunnel origin.
        trustedOrigins: [process.env.BETTER_AUTH_URL],
      }
    : {}),
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
      resource: MCP_RESOURCE,
    }),
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
  ],
});

export type Auth = typeof auth;
