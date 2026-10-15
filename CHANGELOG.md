# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

### Breaking

- **`file_content` is replaced by `read_file`** (no alias): `repository` -> `repo`, `filePath` -> `path`, new `startLine` / `endLine`. Output is numbered; 500 lines by default, 2000 at most, 40,000 characters at most, lines over 2000 characters are clipped. A named `branch` must be an indexed branch (`HEAD` is the default branch). Missing files and repositories, ambiguous branches and files Zoekt did not index (binary or too large) get clear errors.
- **`search` output is rewritten.** Results are grouped as `# <repo>` then `## <path>`; rows are `N:text` for matches and `N-text` for context, with `--` between non-adjacent groups. `Language:`, `Branches: HEAD` and `Stats:` are removed, and a file's branches are shown as `(branches: ...)` after its path only when they are not exactly `HEAD`; the footer after `---` gives totals or says what was truncated. Output is capped at about 20,000 characters (the first file is always shown). Parse rows with `^(\d+)([:-])`.
- **`search` parameter `limit` is replaced by `maxFiles`** (1-100, default 20). The `contextLines` parameter is removed: context is always 2 lines around each match.
- **`list_repos` is reworked.** `filter` is an unanchored, case-insensitive regex on the repository name; new `limit` (1-200, default 50); one line per repository, sorted by name, with a footer when the list was cut at `limit` (narrow with `filter`).
- **HTTP is stateless Streamable HTTP at `POST /mcp`.** `GET /sse` and `POST /messages` return 410 Gone, `/health` and `/` are removed (use `/healthz`), and CORS is removed (browser-based clients are unsupported). SSE-only clients need a bridge such as `mcp-remote`, or stdio.
- **Safer defaults.** The transport is never auto-detected (stdio unless `--transport http` / `MCP_TRANSPORT=http`); HTTP binds to `127.0.0.1` (was `0.0.0.0`) and a non-loopback bind needs `MCP_AUTH_TOKEN`, otherwise it exits 2; `Host` and `Origin` validation on `/mcp` is always on (403); request bodies are capped at 1 MiB.
- **`--timeout` / `ZOEKT_TIMEOUT_MS` are removed.** The Zoekt request timeout is a fixed 30 seconds.
- **`ZOEKT_URL` / `--url` must be an `http://` or `https://` URL.**
- **Requirements and packaging.** Node.js >= 22 (was >= 18) and a Zoekt webserver from 2025-01-30 or later (`read_file` uses `/print?format=raw`). The package has zero runtime dependencies and is CLI-only (`main` is removed).

### Added

- Server `instructions` and title, tool titles and read-only annotations on `search`, `list_repos` and `read_file`.
- `GET /healthz` (process liveness; never touches Zoekt).
- `MCP_ALLOWED_HOSTS` and `MCP_AUTH_TOKEN` for the HTTP transport.
- Context lines in `search` output.
- Cancellation: a client abort cancels the in-flight Zoekt request.
- Clear errors: `Cannot reach Zoekt at <URL> (ECONNREFUSED)`, `Zoekt request timed out after <ms>ms`, and Zoekt's own error text for bad queries.
- Graceful shutdown on SIGINT/SIGTERM.
- Exit code 2 for usage and configuration errors, with a readable message on stderr.

### Changed

- Tool descriptions match real Zoekt behavior (smart-case, case-sensitive `r:`, `branch:HEAD`) and teach `sym:` and `type:file`.
- Migrated to MCP TypeScript SDK v2.

### Fixed

- `list_repos` always failed with a schema error.
- `search` no longer fails on `null` fields in Zoekt's JSON, and no longer strips indentation.
- A `ZOEKT_URL` with credentials works on Node.

### Security

- Credentials in `ZOEKT_URL` are sent as HTTP Basic auth and never appear in errors or logs.
- HTTP is secure by default: loopback bind, mandatory token for non-loopback binds, always-on Host/Origin validation (DNS-rebinding protection), constant-time bearer auth, request body cap, and the token is redacted from logs.

[1.0.0]: https://github.com/itaymendel/zoekt-mcp/compare/v0.1.0...v1.0.0
