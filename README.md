# zoekt-mcp

MCP server for [Zoekt](https://github.com/sourcegraph/zoekt) code search.

## Quick Start

```bash
# Run with npx (no install required)
npx zoekt-mcp --url http://localhost:6070

# Or install globally
npm install -g zoekt-mcp
zoekt-mcp --url http://localhost:6070
```

## CLI Usage

```
zoekt-mcp [OPTIONS]

OPTIONS:
  --url <url>          Zoekt webserver URL (required, or set ZOEKT_URL)
  --transport <mode>   Transport mode: "stdio" (default) or "http"
  --port <number>      HTTP server port (default: 3000)
  --host <address>     HTTP server host (default: 127.0.0.1)
  --log-level <level>  Log level: debug, info, warn, error (default: info)
  --timeout <ms>       Zoekt request timeout in ms (default: 30000)
  --help, -h           Show help
  --version, -v        Show version

EXAMPLES:
  zoekt-mcp --url http://localhost:6070
  zoekt-mcp --url http://localhost:6070 --transport stdio
  zoekt-mcp --url http://localhost:6070 --transport http --port 8080 --log-level debug
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ZOEKT_URL` | (required) | Zoekt webserver URL (`http://` or `https://`); `user:pass@` credentials are sent as HTTP Basic auth and redacted from logs and errors |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_PORT` | `3000` | HTTP server port |
| `MCP_HOST` | `127.0.0.1` | HTTP server host; a non-loopback host requires a token (see below) |
| `MCP_ALLOWED_HOSTS` | (none) | Extra `Host` hostnames, comma-separated, without ports (IPv6 in brackets; `*` disables the check) |
| `MCP_ALLOWED_ORIGINS` | (none) | Extra allowed browser origins, comma-separated (e.g. `https://app.example.com`); also granted CORS |
| `MCP_AUTH_TOKEN` | (none) | Require `Authorization: Bearer <token>` on `/mcp` (at least 16 characters) |
| `MCP_AUTH_TOKEN_FILE` | (none) | Read the bearer token from a file (mutually exclusive with `MCP_AUTH_TOKEN`) |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | `true` allows a non-loopback bind without a token |
| `MCP_MAX_BODY_BYTES` | `1048576` | Largest `/mcp` request body (1024 to 16777216); larger bodies get 413 |
| `MCP_SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period on SIGINT/SIGTERM before connections are dropped (0 to 120000) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ZOEKT_TIMEOUT_MS` | `30000` | Request timeout in milliseconds |

CLI flags take precedence over environment variables. Empty values count as unset. Configuration and usage errors exit with code 2.

## Tools

- **`search`** - Search code with [Zoekt query syntax](https://github.com/sourcegraph/zoekt/blob/main/doc/query_syntax.md)
- **`list_repos`** - List indexed repositories
- **`read_file`** - Read a file from a repository as numbered lines (`repo`, `path`, optional `branch`, `startLine`, `endLine`; at most 500 lines by default, 2000 maximum)

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zoekt": {
      "command": "npx",
      "args": ["zoekt-mcp", "--url", "http://localhost:6070", "--transport", "stdio"]
    }
  }
}
```

Or with environment variables:

```json
{
  "mcpServers": {
    "zoekt": {
      "command": "zoekt-mcp",
      "env": {
        "ZOEKT_URL": "http://localhost:6070",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

## Development

The Bun version is pinned in `.bun-version`; CI uses the same file.

```bash
bun install --frozen-lockfile
ZOEKT_URL=http://localhost:6070 bun run dev
bun test
```

To verify the packed tarball (file list, install footprint, `--version`, stdio smoke), run `bun run build && bun run check:package`.

To check the built bundle the way `npx` users run it (plain Node, stdio):

```bash
bun run build && bun run smoke -- --entry dist/index.js
```

Tests run against real Zoekt responses captured in `tests/fixtures/zoekt`. Docker is only
needed to refresh them:

```bash
bun run fixtures:capture
```

This indexes the synthetic repositories in `tests/fixtures/zoekt/repos` with the Zoekt image
pinned by digest in `scripts/lib/zoekt-docker.ts` and rewrites `tests/fixtures/zoekt/cases`
and `MANIFEST.json`. To bump Zoekt, change the digest (`ZOEKT_IMAGE`), re-run the command and
review the diff.

## License

MIT
