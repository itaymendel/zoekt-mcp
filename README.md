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
  --transport <mode>   Transport mode: "http" or "stdio" (default: auto-detect)
  --port <number>      HTTP server port (default: 3000)
  --host <address>     HTTP server host (default: 0.0.0.0)
  --log-level <level>  Log level: debug, info, warn, error (default: info)
  --timeout <ms>       Zoekt request timeout in ms (default: 30000)
  --help, -h           Show help
  --version, -v        Show version

EXAMPLES:
  zoekt-mcp --url http://localhost:6070
  zoekt-mcp --url http://localhost:6070 --transport stdio
  zoekt-mcp --url http://localhost:6070 --port 8080 --log-level debug
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ZOEKT_URL` | (required) | Zoekt webserver URL |
| `MCP_TRANSPORT` | auto-detect | `http` or `stdio` |
| `MCP_PORT` | `3000` | HTTP server port |
| `MCP_HOST` | `0.0.0.0` | HTTP server host |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ZOEKT_TIMEOUT_MS` | `30000` | Request timeout in milliseconds |

CLI flags take precedence over environment variables.

## Tools

- **`search`** - Search code with [Zoekt query syntax](https://github.com/sourcegraph/zoekt/blob/main/doc/query_syntax.md)
- **`list_repos`** - List indexed repositories
- **`file_content`** - Get file contents from a repository

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
