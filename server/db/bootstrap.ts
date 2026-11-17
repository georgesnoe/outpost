/**
 * Bootstrap DDL generated from the Better Auth schema (auth generate + drizzle-kit).
 * Mirrors server/db/schema.ts so a fresh database works in dev and from .output.
 */
export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" integer,
	"refresh_token_expires_at" integer,
	"scope" text,
	"password" text,
	"created_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "fk_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "jwks" (
	"id" text PRIMARY KEY,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" integer NOT NULL,
	"expires_at" integer,
	"alg" text,
	"crv" text
);

CREATE TABLE IF NOT EXISTS "oauth_access_token" (
	"id" text PRIMARY KEY,
	"token" text NOT NULL UNIQUE,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text,
	"requested_user_info_claims" text,
	"refresh_id" text,
	"expires_at" integer NOT NULL,
	"created_at" integer NOT NULL,
	"revoked" integer,
	"confirmation" text,
	"scopes" text NOT NULL,
	CONSTRAINT "fk_oauth_access_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
	CONSTRAINT "fk_oauth_access_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL,
	CONSTRAINT "fk_oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE,
	CONSTRAINT "fk_oauth_access_token_refresh_id_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "oauth_refresh_token"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "oauth_client" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL UNIQUE,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" integer DEFAULT false,
	"skip_consent" integer,
	"enable_end_session" integer,
	"subject_type" text,
	"scopes" text,
	"client_credentials_scopes" text DEFAULT '[]',
	"user_id" text,
	"created_at" integer,
	"updated_at" integer,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text,
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text NOT NULL,
	"post_logout_redirect_uris" text,
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" integer,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text,
	"response_types" text,
	"require_pkce" integer,
	"dpop_bound_access_tokens" integer DEFAULT false,
	"reference_id" text,
	"metadata" text,
	CONSTRAINT "fk_oauth_client_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "oauth_client_assertion" (
	"id" text PRIMARY KEY,
	"expires_at" integer NOT NULL
);

CREATE TABLE IF NOT EXISTS "oauth_client_resource" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" text,
	"created_at" integer,
	CONSTRAINT "fk_oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
	CONSTRAINT "fk_oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "oauth_resource"("identifier") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "oauth_consent" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text,
	"requested_user_info_claims" text,
	"scopes" text NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "fk_oauth_consent_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
	CONSTRAINT "fk_oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "oauth_refresh_token" (
	"id" text PRIMARY KEY,
	"token" text NOT NULL UNIQUE,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text,
	"requested_user_info_claims" text,
	"expires_at" integer NOT NULL,
	"created_at" integer NOT NULL,
	"revoked" integer,
	"rotated_at" integer,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" integer,
	"auth_time" integer,
	"confirmation" text,
	"scopes" text NOT NULL,
	CONSTRAINT "fk_oauth_refresh_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
	CONSTRAINT "fk_oauth_refresh_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL,
	CONSTRAINT "fk_oauth_refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "oauth_resource" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text,
	"custom_claims" text,
	"dpop_bound_access_tokens_required" integer DEFAULT false,
	"disabled" integer DEFAULT false,
	"created_at" integer,
	"updated_at" integer,
	"policy_version" integer DEFAULT 1,
	"metadata" text
);

CREATE TABLE IF NOT EXISTS "session" (
	"id" text PRIMARY KEY,
	"expires_at" integer NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	"updated_at" integer NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "fk_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" integer DEFAULT false NOT NULL,
	"image" text,
	"created_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	"updated_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" integer NOT NULL,
	"created_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	"updated_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);

CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("user_id");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" ON "oauth_access_token" ("client_id");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_sessionId_idx" ON "oauth_access_token" ("session_id");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" ON "oauth_access_token" ("user_id");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_authorizationCodeId_idx" ON "oauth_access_token" ("authorization_code_id");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_refreshId_idx" ON "oauth_access_token" ("refresh_id");
CREATE INDEX IF NOT EXISTS "oauthClient_userId_idx" ON "oauth_client" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "oauthClientResource_clientId_resourceId_uidx" ON "oauth_client_resource" ("client_id","resource_id");
CREATE INDEX IF NOT EXISTS "oauthClientResource_clientId_idx" ON "oauth_client_resource" ("client_id");
CREATE INDEX IF NOT EXISTS "oauthClientResource_resourceId_idx" ON "oauth_client_resource" ("resource_id");
CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" ON "oauth_consent" ("client_id");
CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" ON "oauth_consent" ("user_id");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_clientId_idx" ON "oauth_refresh_token" ("client_id");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_sessionId_idx" ON "oauth_refresh_token" ("session_id");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_userId_idx" ON "oauth_refresh_token" ("user_id");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_authorizationCodeId_idx" ON "oauth_refresh_token" ("authorization_code_id");
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("user_id");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");
`;

/** Keep foreign keys and WAL enabled for every connection. */
export const PRAGMAS_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
`;
