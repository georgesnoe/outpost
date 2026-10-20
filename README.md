# Outpost

[![GitHub stars](https://img.shields.io/github/stars/georgesnoe/outpost?style=social)](https://github.com/georgesnoe/outpost)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Outpost is a self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server that puts a shell on the machine it runs on. It ships a single tool, `exec`, that lets an AI agent run real commands and read the real output — PowerShell on Windows, Bash on Linux and macOS.

It is deliberately small: a handful of tools, one binary, one port.

## Why Outpost

Most AI agents can talk to a codebase but not to the machine around it. Outpost closes that gap: point any MCP client at it and the agent gains shell access — check disk usage, tail a log, restart a service, build a project.

- **One tool, no framework.** `exec` takes a command and returns its output. Nothing else to learn.
- **Runs where you do.** The same binary on Windows, Linux and macOS, using the native shell of each.
- **Self-hosted.** The server runs on your hardware. Your commands never leave the box.
- **Ships as a single file.** One compiled executable, no runtime to install on the target machine.

## The `exec` tool

| Argument  | Type   | Default              | Description                                               |
| --------- | ------ | -------------------- | --------------------------------------------------------- |
| `command` | string | —                    | The command to run. Required.                             |
| `cwd`     | string | server's working dir | Directory to run the command in.                          |
| `timeout` | number | `30000` (30s)        | Timeout in milliseconds. Capped at `600000` (10 minutes). |

The tool returns the combined stdout and stderr plus the exit code, and flags a non-zero exit as an error. Output longer than 100 000 characters is truncated.

```jsonc
// tools/call
{
  "name": "exec",
  "arguments": {
    "command": "git status --short",
    "cwd": "/home/user/project",
    "timeout": 10000
  }
}
```

The shell is chosen automatically from the host platform:

| Platform | Shell      | Invocation                                           |
| -------- | ---------- | ---------------------------------------------------- |
| Windows  | PowerShell | `powershell.exe -NoProfile -NonInteractive -Command` |
| Linux    | Bash       | `bash -c`                                            |
| macOS    | Bash       | `bash -c`                                            |

## Quick start

Requires [Bun](https://bun.sh).

```bash
bun install
bun run start
```

The server listens on port `65432` and speaks the Streamable HTTP transport. Reach it at `http://localhost:65432/mcp`, point any MCP client at that URL, and the `exec` tool shows up in the tool list.

### Connect a client

```json
{
  "mcpServers": {
    "outpost": {
      "type": "http",
      "url": "http://localhost:65432/mcp"
    }
  }
}
```

### Build a standalone binary

```bash
bun run build
```

This produces a single self-contained executable — `outpost` on Linux and macOS, `outpost.exe` on Windows — that runs the server without Bun installed. Copy it to any machine and start it.

To build for a specific platform from any host, use the `build:target` script:

```bash
TARGET=bun-darwin-arm64 OUTFILE=outpost-macos-arm64 bun run build:target
```

### Download a prebuilt binary

Every tagged release ships standalone builds for Windows, Linux and macOS — no runtime required:

| Platform    | Asset                     |
| ----------- | ------------------------- |
| Linux x64   | `outpost-linux-x64.zip`   |
| Linux arm64 | `outpost-linux-arm64.zip` |
| macOS x64   | `outpost-macos-x64.zip`   |
| macOS arm64 | `outpost-macos-arm64.zip` |
| Windows x64 | `outpost-windows-x64.zip` |

Grab them from the [releases page](https://github.com/georgesnoe/outpost/releases). macOS binaries are unsigned, so Gatekeeper may block the first launch — run `xattr -d com.apple.quarantine outpost` once, or right-click the app and choose Open.

## Expose it to an online LLM

Outpost runs on your machine, so a hosted model cannot reach it on its own. Put a tunnel in front of the server to publish the endpoint on the public internet, then give your client the tunnel URL.

### With localtunnel

[localtunnel](https://localtunnel.me) needs no account and no install:

```bash
bunx concurrently 'bun run start' 'bunx localtunnel --port 65432'
```

`concurrently` runs the server and the tunnel side by side and stops them together. The tunnel prints the public URL it assigned you:

```
your url is: https://cool-lions-sing.loca.lt
```

The MCP endpoint is that URL with `/mcp` appended:

```json
{
  "mcpServers": {
    "outpost": {
      "type": "http",
      "url": "https://cool-lions-sing.loca.lt/mcp"
    }
  }
}
```

### With cloudflared

[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gives you a quick tunnel with a random domain, also without an account:

```bash
bunx concurrently 'bun run start' 'cloudflared tunnel --url http://localhost:65432'
```

Or, if cloudflared is already installed:

```bash
cloudflared tunnel --url http://localhost:65432
```

It prints something like:

```
https://quiet-broken-fox.trycloudflare.com
```

Again, the MCP endpoint is that URL plus `/mcp`.

### ⚠️ You are publishing a shell

A tunnel makes the endpoint reachable by anyone who has the URL, and every command it accepts runs with the server's privileges. Before pointing a hosted model at it:

- Treat the tunnel URL as a password. It lands in your shell history and in the logs of whatever you paste it into.
- Do not leave the tunnel running unattended — close it when you are done.
- Prefer a short-lived tunnel over a permanent one, and a model you trust over a URL you forgot about.
- localtunnel may answer browser-like visitors with a consent page asking for the tunnel password. Programmatic clients are served directly, but cloudflared is the smoother option for API traffic.
- Authentication is on the roadmap but not in this release — until it lands, the tunnel URL is your access control.

## Security

Outpost hands out shell access. Treat the server as a remote shell.

- It listens on port `65432` on every network interface, so anything that can route to your machine can reach it. Keep the machine on a trusted network, or bind it to a single interface.
- Anyone who can reach the endpoint can run any command with the server's privileges.
- A tunnel publishes that endpoint to the internet — read the warnings above before you set one up.
- Authentication and per-command allowlists are planned, but not in this release.

## Roadmap

Outpost is early and **more versions are coming**. Planned for the next releases:

- More tools beyond `exec` — file read/write, search, process and service management.
- Authentication and per-tool permissions.
- Command allowlists, denylists and working-directory scoping.
- Streaming output for long-running commands.
- A stdio transport for local editor and agent integrations.
- Packaged releases for Windows, Linux and macOS.

Want to steer the roadmap? Open an issue.

## Contributing

Issues and pull requests are welcome. Run the checks before you push:

```bash
bun run typecheck
bun run format
```

## Star this repo

If Outpost is useful to you — or if you want to follow its development — **please give it a star**. It costs nothing, it is the single best way to support the project, and it helps other people find it.

[⭐ Star georgesnoe/outpost](https://github.com/georgesnoe/outpost)

## License

MIT © 2026 Kossi Georges-Noé AHOMBO
