# Outpost

A single-host [Nitro](https://nitro.build) v3 server that exposes a set of
system/file/process/search tools over MCP, with [Better Auth](https://www.better-auth.com)
providing authentication and an OAuth 2.1 authorization server for MCP clients.

## Stack

- **Nitro v3 / H3 v2** server (`server/`)
- **`@modelcontextprotocol/server`** for the MCP endpoint at `/mcp`
- **Better Auth** with the `jwt`, `mcp` and `cimd` plugins
- **Drizzle ORM** using Node's built-in `node:sqlite` driver (no `sqlite3` package)
- **Bun** for the single-file binary build

## Requirements

- Bun 1.4+ (for `bun install`, `bun run`, and `npm run build:binary`)
- The compiled binary needs no Node.js or Bun installation on the target machine

## Getting started

```bash
bun install
cp .env.example .env   # then edit the values
bun run dev
```

The dev server listens on **port 65432** by default.

## Scripts

| Script                 | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `bun run dev`          | Start the Nitro development server                      |
| `bun run build`        | Build a regular `.output/` server (Node preset)         |
| `bun run preview`      | Preview a built server                                  |
| `bun run build:binary` | Build a standalone single-file executable into `dist/`  |
| `bun run db:generate`  | Generate a Drizzle migration from `server/db/schema.ts` |
| `bun run db:migrate`   | Apply generated migrations to the SQLite database       |
| `bun run db:push`      | Push the schema directly to the database                |
| `bun run db:studio`    | Open Drizzle Studio                                     |
| `bun run format`       | Format the project with Prettier                        |
| `bun run lint`         | Lint with ESLint                                        |

## Single-file binary

```bash
npm run build:binary
```

The build script:

1. Loads values from `.env` (real environment variables take precedence).
2. Builds Nitro with the `bun` preset and inlined static assets.
3. Compiles the server into `dist/outpost` (`.exe` on Windows), baking in the
   app configuration from `.env` so no `.env`, `node_modules` or `.output`
   directory is needed at runtime.

Run it from any directory:

```bash
./dist/outpost
PORT=8080 ./dist/outpost      # override the port at runtime
```

Optional build variables:

- `BINARY_TARGET` — Bun compile target, e.g. `bun-linux-x64`, `bun-darwin-arm64`,
  `bun-windows-x64`. Defaults to the current platform. A binary is only
  portable to the OS/architecture it was built for.
- `BINARY_NAME` — output name without extension (default `outpost`).

## Configuration

Copy `.env.example` to `.env`. All values are optional:

| Variable             | Default                       | Purpose                                               |
| -------------------- | ----------------------------- | ----------------------------------------------------- |
| `PORT`               | `65432`                       | Port the server listens on                            |
| `DB_FILE_NAME`       | `outpost.db`                  | SQLite filename, resolved under `~/.config/outpost`   |
| `BETTER_AUTH_SECRET` | development fallback          | Session/token signing secret — set this in production |
| `BETTER_AUTH_URL`    | inferred from request         | Public base URL used by Better Auth                   |
| `MCP_RESOURCE_URL`   | `https://api.example.com/mcp` | Canonical MCP protected resource identifier           |

The database and Better Auth tables are created automatically on first start,
including from the compiled binary.

## HTTP endpoints

- `/mcp` — MCP endpoint (JSON-RPC; GET/POST/DELETE)
- `/api/auth/*` — Better Auth routes (sign-in, OAuth 2.1, JWKS, etc.)
- `/sign-in.html` — login page used by the OAuth authorization flow
- `/consent.html` — consent page for client authorization
- `/.well-known/oauth-protected-resource` — RFC 9728 metadata for MCP clients

## MCP tools

`exec` plus tools for processes (`process_start`, `process_kill`,
`process_input`, `process_output`, `process_list`, `process_info`), files
(`file_read`, `file_write`, `file_edit`, `file_move`, `file_delete`, …),
directories, searches, system/resources/information, configuration, usage
statistics, clipboard, notifications, port listing and diffs. All tools adapt
their implementation to Windows, macOS and Linux.

> **Warning:** these tools are powerful and are not sandboxed. Do not expose
> this server to untrusted networks without authentication and access controls.

## Database schema

`server/db/schema.ts` is generated with:

```bash
bun x auth generate --config ./server/utils/auth.ts --yes
```

The generated relation definitions are kept in Drizzle's Relations v2 form
(`defineRelations`) because the CLI emits the removed v1 API. The generated
tables cover the core auth tables plus the OAuth provider/JWT tables used by
the `mcp` plugin.

## Notes

- The `/mcp` route is currently open. To require OAuth tokens on it, wrap the
  MCP handler with `requireMcpAuth` from `@better-auth/mcp`.
- Sessions and OAuth state are stored in the same SQLite file under
  `~/.config/outpost`.
