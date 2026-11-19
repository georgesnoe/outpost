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
bun run dev
```

On first launch the server creates `~/.config/outpost/config.json` (next to
`outpost.db`) with default values. An empty `{}` means "use defaults". There is
no need to create a `.env` file. The dev server listens on **port 65432** by
default.

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

1. Builds Nitro with the `bun` preset and inlined static assets.
2. Compiles the server into `dist/outpost` (`.exe` on Windows).
3. Reads configuration at runtime from `~/.config/outpost/config.json`, so
   no `.env`, `node_modules` or `.output` directory is needed at runtime.

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

Runtime configuration lives in `~/.config/outpost/config.json`, next to the
SQLite database. It is created automatically as `{}` on first launch; see
`config.example.json` and `config.schema.json` in the repository for the
schema and a template.

| Key              | Default                       | Purpose                                               |
| ---------------- | ----------------------------- | ----------------------------------------------------- |
| `port`           | `65432`                       | Port the server listens on                            |
| `secret`         | development fallback          | Session/token signing secret — set this in production |
| `url`            | `http://localhost:65432`      | Public origin used by Better Auth (the tunnel URL)    |
| `dbFileName`     | `outpost.db`                  | SQLite filename, resolved inside `~/.config/outpost`  |
| `mcpResourceUrl` | `https://api.example.com/mcp` | Canonical MCP protected resource identifier           |
| `keys`           | `{}`                          | Optional application keys/tokens                      |

Environment variables can override individual keys at runtime:
`PORT`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DB_FILE_NAME`,
`MCP_RESOURCE_URL`. A `.env` file is optional and only acts as an override —
it is never used to create `config.json`.

The database and Better Auth tables are created automatically on first start,
including from the compiled binary.

## HTTP endpoints

- `/mcp` — OAuth-protected MCP endpoint (stateless `POST`, MCP 2026-07-28)
- `/api/auth/*` — Better Auth routes (sign-in, OAuth 2.1, JWKS, etc.)
- `/sign-in.html` — login page used by the OAuth authorization flow
- `/sign-up.html` — account creation page (`prompt=create`); continues the
  authorization flow automatically after registration
- `/consent.html` — consent page for client authorization
- `/.well-known/oauth-protected-resource` — RFC 9728 metadata for MCP clients

## MCP tools

`exec` plus tools for processes (`process_start`, `process_kill`,
`process_input`, `process_output`, `process_list`, `process_info`), files
(`file_read`, `file_write`, `file_edit`, `file_move`, `file_delete`, …),
directories, searches, system/resources/information, configuration, usage
statistics, clipboard, notifications, port listing and diffs. All tools adapt
their implementation to Windows, macOS and Linux.

Desktop automation tools: `mouse_click`, `mouse_move`, `mouse_scroll`,
`mouse_drag`, `keyboard_type`, `keyboard_press`, `keyboard_hotkey`, `screenshot`,
`get_screen_info`, `get_active_window`, `get_cursor_position`. Browser tools
(`browser_navigate`, `browser_get_info`, `browser_get_tabs`, `browser_back`,
`browser_forward`) drive the **system default browser** through OS-native
APIs. The redundant `browser_switch_tab`, `browser_click`, `browser_type`,
`browser_press`, `browser_drag` and `browser_screenshot` registrations are
commented out in `server/tools/browser.ts` because global mouse/keyboard and
screenshot tools cover them. The `screenshot` tool returns a real MCP
`ImageContent` block, so the agent can see the image.

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

- `BETTER_AUTH_URL` must be the public origin (the cloudflared tunnel URL), not
  `localhost`. Otherwise the discovery documents advertise a localhost issuer
  and MCP clients report that they cannot find the OAuth parameters.
- `MCP_RESOURCE_URL` must match the public `/mcp` URL exactly, including the
  path, so the `aud` claim and `resource_metadata` challenge point to the same
  resource.
- The `/mcp` route is wrapped with `requireMcpAuth` from `@better-auth/mcp`.
  Unauthenticated requests receive a JSON-RPC 401 with a `WWW-Authenticate`
  header that points at `/.well-known/oauth-protected-resource/mcp`.
- Sessions and OAuth state are stored in the same SQLite file under
  `~/.config/outpost`.
