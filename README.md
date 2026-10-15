# zoekt-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents fast code search over repositories indexed by [Zoekt](https://github.com/sourcegraph/zoekt). Read-only tools: `search`, `list_repos`, `read_file` and `search_syntax`.

**Status: 1.0.0-alpha.** Install the `next` tag (`npx -y zoekt-mcp@next`). `latest` still points at 0.1.0 until 1.0.0 ships.

**Requirements**

- Node.js 22 or newer.
- A running `zoekt-webserver` from 2025-01-30 or later (it must serve `/print?format=raw`). The official image `ghcr.io/sourcegraph/zoekt` works.

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

### Streamable HTTP (one shared server)

Run a single server next to Zoekt and point clients at `/mcp`:

```bash
export TOKEN=$(openssl rand -hex 24)
ZOEKT_URL=http://localhost:6070 MCP_AUTH_TOKEN=$TOKEN MCP_HOST=0.0.0.0 npx -y zoekt-mcp@next --transport http
claude mcp add --transport http zoekt http://zoekt-mcp.internal:3000/mcp --header "Authorization: Bearer $TOKEN"
```

The server is stateless Streamable HTTP on `POST /mcp`; `GET /healthz` reports process liveness without touching Zoekt (use it for container probes). It binds to `127.0.0.1` by default. Any other bind needs `MCP_AUTH_TOKEN`, so it cannot be exposed unauthenticated by accident. There is no TLS: terminate it at your proxy or ingress.

## Tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `search` | Search code with Zoekt query syntax | `query`, `maxFiles` (1-100, default 20) |
| `search_syntax` | Read the Zoekt query-language guide, one section at a time | `topic` (omit to list the sections) |
| `list_repos` | List indexed repositories | `filter` (regex on the name, case-insensitive), `limit` (1-200, default 50) |
| `read_file` | Read a file as numbered lines | `repo`, `path`, `branch`, `startLine`, `endLine` (500 lines by default, 2000 at most) |

All four are read-only and closed-world; clients that honour tool annotations can run them without confirmation. The server also sends short `instructions` describing the `list_repos` -> `search` -> `read_file` workflow.

Credentials in `ZOEKT_URL` are sent as Basic auth and never logged. On a loopback bind the HTTP server validates `Host` and `Origin` (DNS-rebinding protection), and `/mcp` bodies are capped at 1 MiB.

## Configuration

CLI flags take precedence over environment variables. Invalid flags or environment values print a readable message to stderr and exit with code 1. `zoekt-mcp --help` lists every option.

| Flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--url` | `ZOEKT_URL` | required | Zoekt webserver URL (`http://` or `https://`) |
| `--transport` | `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `--port` | `MCP_PORT` | `3000` | HTTP port |
| | `MCP_HOST` | `127.0.0.1` | HTTP bind address |
| | `MCP_AUTH_TOKEN` | none | Bearer token for `/mcp`; required for any non-loopback bind |
| | `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` (logs go to stderr) |

## Troubleshooting

- **`418` or a Zoekt error message.** Zoekt rejected the query; the tool error includes Zoekt's own text (usually a regex or syntax problem).
- **`sym:` returns nothing.** The repository was indexed without ctags (or has no symbols in that language). Search for the name as plain text instead, or re-index with ctags available.
- **`Cannot reach Zoekt at ... (ECONNREFUSED)`.** Check `ZOEKT_URL` and that `zoekt-webserver` is running; from a container, `localhost` is the container itself.
- **`NOT-INDEXED` from `read_file`.** Zoekt skips binary and oversized files, so they cannot be read through this server.
- **`r:name` finds nothing.** Repository regexes are case-sensitive; use `r:(?i)name`, or run `list_repos` for the exact name.

- **403 on `/mcp`.** On a loopback bind the `Host` or `Origin` header must be localhost; to serve other hostnames, bind to a non-loopback address and set `MCP_AUTH_TOKEN`.

## Acknowledgements

`search_syntax` serves the [Zoekt query language guide](https://github.com/sourcegraph/zoekt/blob/main/doc/query_syntax.md), bundled verbatim (Apache License 2.0, Sourcegraph).

## Upgrading

From 0.1.x? See the [CHANGELOG](CHANGELOG.md).

## Development

The Bun version is pinned in `.bun-version`; CI uses the same file.

```bash
bun install --frozen-lockfile
ZOEKT_URL=http://localhost:6070 bun run dev
bun run lint && bun run typecheck && bun test
```

Tests run against real Zoekt responses captured in `tests/fixtures/zoekt/cases`.

## Releasing

Releases are published by hand; there is no release workflow. Prereleases go out under the `next` dist-tag.

1. From a clean checkout: `bun install --frozen-lockfile && bun run lint && bun run typecheck && bun test && bun run build`.
2. `npm publish --tag next --access public` (drop `--tag next` for a stable release), then verify with `npm view zoekt-mcp dist-tags --json`.
3. `git tag v<version> && git push origin v<version>`. Never republish a version; fix forward and `npm deprecate` the bad one.

## License

MIT
