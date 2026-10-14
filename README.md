# zoekt-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents fast code search over repositories indexed by [Zoekt](https://github.com/sourcegraph/zoekt). Three read-only tools: `search`, `list_repos` and `read_file`.

**Status: 1.0.0-alpha.** Install the `next` tag (`npx -y zoekt-mcp@next`). `latest` still points at 0.1.0 until 1.0.0 ships.

**Requirements**

- Node.js 22 or newer.
- A running `zoekt-webserver` from 2025-01-30 or later (it must serve `/print?format=raw`). The official image `ghcr.io/sourcegraph/zoekt` works; tests run against the revision pinned in `scripts/lib/zoekt-docker.ts`.

## Quick start

1. Index a git repository and start Zoekt (run this from the repository root; the index lives in the `zoekt-index` Docker volume):

   ```bash
   docker run --rm -v "$PWD":/repos/demo:ro -v zoekt-index:/data/index \
     -e HOME=/tmp -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
     --entrypoint zoekt-git-index ghcr.io/sourcegraph/zoekt -index /data/index /repos/demo
   docker run -d --name zoekt -p 6070:6070 -v zoekt-index:/data/index ghcr.io/sourcegraph/zoekt
   ```

   The repository is named after its mount directory, so it is searchable as `demo` (change `/repos/demo` to rename it). Zoekt builds a symbol index with ctags by default, which `sym:` queries need.

2. Check that the server starts (it speaks MCP on stdin/stdout, so this prints the version and exits):

   ```bash
   npx -y zoekt-mcp@next --version
   ```

3. Connect a client (below).

## Connect a client

### stdio (Claude Code, Claude Desktop, and most other clients)

The client starts the server itself. Claude Code:

```bash
claude mcp add zoekt -e ZOEKT_URL=http://localhost:6070 -- npx -y zoekt-mcp@next
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "zoekt": {
      "command": "npx",
      "args": ["-y", "zoekt-mcp@next"],
      "env": { "ZOEKT_URL": "http://localhost:6070" }
    }
  }
}
```

Other clients (Cursor, VS Code, ...) use the same command, arguments and `ZOEKT_URL` variable in their own MCP settings.

### Streamable HTTP

Run one shared server, then point clients at `/mcp`:

```bash
ZOEKT_URL=http://localhost:6070 npx -y zoekt-mcp@next --transport http
claude mcp add --transport http zoekt http://127.0.0.1:3000/mcp
```

With a bearer token (required when binding anything but loopback; at least 16 characters):

```bash
export TOKEN=$(openssl rand -hex 24)
ZOEKT_URL=http://localhost:6070 MCP_AUTH_TOKEN=$TOKEN npx -y zoekt-mcp@next --transport http
claude mcp add --transport http zoekt http://127.0.0.1:3000/mcp --header "Authorization: Bearer $TOKEN"
```

The HTTP transport is stateless Streamable HTTP on `POST /mcp`. `GET /healthz` reports process liveness without touching Zoekt.

## Tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `search` | Search code with Zoekt query syntax | `query`, `maxFiles` (1-100, default 20), `maxMatchesPerFile` (1-50, default 5), `contextLines` (0-10, default 2) |
| `list_repos` | List indexed repositories | `filter` (regex on the name, case-insensitive), `limit` (1-200, default 50), `offset` |
| `read_file` | Read a file as numbered lines | `repo`, `path`, `branch`, `startLine`, `endLine` (500 lines by default, 2000 at most) |

All three are read-only and closed-world; clients that honour tool annotations can run them without confirmation. The server also sends short `instructions` describing the `list_repos` -> `search` -> `read_file` workflow.

## Security

- **Loopback by default.** HTTP binds to `127.0.0.1`. Binding any other address without `MCP_AUTH_TOKEN` (or `MCP_AUTH_TOKEN_FILE`) is refused: the server exits with code 2 unless `MCP_ALLOW_UNAUTHENTICATED=true`.
- **Bearer token.** `MCP_AUTH_TOKEN` or `MCP_AUTH_TOKEN_FILE` (not both) sets a token of at least 16 characters. `/mcp` then requires `Authorization: Bearer <token>`, compared in constant time; the token is never logged.
- **Host and Origin validation** on `/mcp` is always on (DNS-rebinding protection). Loopback names are always allowed; add others with `MCP_ALLOWED_HOSTS` (hostnames without ports; IPv6 literals in brackets) and `MCP_ALLOWED_ORIGINS` (browser origins, which are also granted CORS).
- **Body cap.** Request bodies over 1 MiB get 413.
- **Zoekt credentials.** `ZOEKT_URL=https://user:pass@host` is sent as HTTP Basic auth and never appears in logs or errors.
- **Behind a reverse proxy**, terminate TLS there, forward the original `Host`, and list the public hostname in `MCP_ALLOWED_HOSTS`. Do not expose the server without a token.
- `/healthz` is exempt from these checks.

## Configuration

CLI flags take precedence over environment variables. Empty values count as unset. Usage and configuration errors print a readable message to stderr and exit with code 2.

| Flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--url` | `ZOEKT_URL` | required | Zoekt webserver URL (`http://` or `https://`) |
| `--transport` | `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `--port` | `MCP_PORT` | `3000` | HTTP port |
| `--host` | `MCP_HOST` | `127.0.0.1` | HTTP bind address |
| `--log-level` | `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` (logs go to stderr) |
| `--timeout` | `ZOEKT_TIMEOUT_MS` | `30000` | Zoekt request timeout in ms (1000 to 300000) |
| | `MCP_ALLOWED_HOSTS` | none | Extra `Host` hostnames, comma-separated |
| | `MCP_ALLOWED_ORIGINS` | none | Extra allowed browser origins, comma-separated |
| | `MCP_AUTH_TOKEN` | none | Bearer token for `/mcp` (at least 16 characters) |
| | `MCP_AUTH_TOKEN_FILE` | none | Read the token from a file (exclusive with `MCP_AUTH_TOKEN`) |
| | `MCP_ALLOW_UNAUTHENTICATED` | `false` | `true` allows a non-loopback bind without a token |

## Troubleshooting

- **`418` or a Zoekt error message.** Zoekt rejected the query; the tool error includes Zoekt's own text (usually a regex or syntax problem).
- **`sym:` returns nothing.** The repository was indexed without ctags (or has no symbols in that language). Search for the name as plain text instead, or re-index with ctags available.
- **`Cannot reach Zoekt at ... (ECONNREFUSED)`.** Check `ZOEKT_URL` and that `zoekt-webserver` is running; from a container, `localhost` is the container itself.
- **`NOT-INDEXED` from `read_file`.** Zoekt skips binary and oversized files, so they cannot be read through this server.
- **`r:name` finds nothing.** Repository regexes are case-sensitive; use `r:(?i)name`, or run `list_repos` for the exact name.
- **403 on `/mcp`.** The `Host` or `Origin` header is not allowed; see `MCP_ALLOWED_HOSTS`.

## Upgrading

From 0.1.x? See the [CHANGELOG](CHANGELOG.md).

## Development

The Bun version is pinned in `.bun-version`; CI uses the same file.

```bash
bun install --frozen-lockfile
ZOEKT_URL=http://localhost:6070 bun run dev
bun run lint && bun run typecheck && bun test
```

To check the packed tarball the way `npx` users run it (exact file list, zero runtime dependencies, the installed bin lists the three tools over stdio and answers `/healthz` over HTTP):

```bash
bun run build
bun run check:package
```

Tests run against real Zoekt responses captured in `tests/fixtures/zoekt`. Docker is only needed to refresh them:

```bash
bun run fixtures:capture
```

## Releasing

Releases are published by hand; there is no release workflow. Prereleases go out under the `next` dist-tag.

1. From a clean checkout: `bun install --frozen-lockfile && bun run lint && bun run typecheck && bun test && bun run build && bun run check:package`.
2. `npm publish --tag next --access public` (drop `--tag next` for a stable release), then verify with `npm view zoekt-mcp dist-tags --json`.
3. `git tag v<version> && git push origin v<version>`. Never republish a version; fix forward and `npm deprecate` the bad one.

## License

MIT
