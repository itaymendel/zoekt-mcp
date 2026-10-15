# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

- **`file_content` is replaced by `read_file`** (no alias): `repository` -> `repo`, `filePath` -> `path`, new `startLine` / `endLine`. Output is numbered; 500 lines by default, 2000 at most, 40,000 characters at most, lines over 2000 characters are clipped. A named `branch` must be an indexed branch (`HEAD` is the default branch). Missing files and repositories, ambiguous branches and files Zoekt did not index (binary or too large) get clear errors.
- **`search` output is rewritten.** Results are grouped as `# <repo>` then `## <path>`; rows are `N:text` for matches and `N-text` for context, with `--` between non-adjacent groups. `Language:`, `Branches: HEAD` and `Stats:` are removed, and a file's branches are shown as `(branches: ...)` after its path only when they are not exactly `HEAD`; the footer after `---` gives totals or says what was truncated. Output is capped at about 20,000 characters (the first file is always shown). Parse rows with `^(\d+)([:-])`.
- **`search` parameter `limit` is replaced by `maxFiles`** (1-100, default 20). The `contextLines` parameter is removed: context is always 2 lines around each match.
- **`list_repos` is reworked.** `filter` is an unanchored, case-insensitive regex on the repository name; new `limit` (1-200, default 50); one line per repository (name and branches), sorted by name, with a footer when the list was cut at `limit` (narrow with `filter`).
- **HTTP is stateless Streamable HTTP at `POST /mcp`.** `GET /sse` and `POST /messages` are gone (404), so SSE-only clients need a bridge such as `mcp-remote`, or stdio. CORS is removed (browser-based clients are unsupported).
- **Safer defaults.** The transport is never auto-detected (stdio unless `--transport http` / `MCP_TRANSPORT=http`); HTTP binds to `127.0.0.1` (was `0.0.0.0`) and a non-loopback bind needs `MCP_AUTH_TOKEN`, otherwise it refuses to start; loopback binds validate `Host` and `Origin`; request bodies are capped at 1 MiB.
- **`--timeout` / `ZOEKT_TIMEOUT_MS` are removed.** The Zoekt request timeout is a fixed 30 seconds.
- **`ZOEKT_URL` / `--url` must be an `http://` or `https://` URL.**
- **Requirements and packaging.** Node.js >= 22 (was >= 18) and a Zoekt webserver from 2025-01-30 or later (`read_file` uses `/print?format=raw`). The package has zero runtime dependencies and is CLI-only (`main` is removed).

### Added

- Server `instructions` and title, tool titles and read-only annotations on `search`, `search_syntax`, `list_repos` and `read_file`.
- A shared, centrally deployed server: `GET /healthz` (process liveness) and `MCP_AUTH_TOKEN` bearer auth for the HTTP transport, built on Hono and the MCP SDK's Hono adapter.
- `search_syntax` tool: the full Zoekt query-language guide, served on demand by section so the `search` description stays short. A query Zoekt rejects points to it.
- Context lines in `search` output.
- Cancellation: a client abort cancels the in-flight Zoekt request.
- Clear errors: `Cannot reach Zoekt at <URL> (ECONNREFUSED)`, `Zoekt request timed out after <ms>ms`, and Zoekt's own error text for bad queries.
- Graceful shutdown on SIGINT/SIGTERM.
- Readable usage and configuration errors on stderr (exit code 1), via Commander.

### Changed

- Tool descriptions match real Zoekt behavior (smart-case, case-sensitive `r:`, `branch:HEAD`) and teach `sym:` and `type:file`.
- Migrated to MCP TypeScript SDK v2.

### Fixed

- `list_repos` always failed with a schema error.
- `search` no longer fails on `null` fields in Zoekt's JSON, and no longer strips indentation.
- A `ZOEKT_URL` with credentials works on Node.

### Security

- Credentials in `ZOEKT_URL` are sent as HTTP Basic auth and never appear in errors or logs.
- HTTP is secure by default: loopback bind, mandatory token for non-loopback binds, constant-time bearer auth, Host/Origin validation on loopback, request body cap.

[Unreleased]: https://github.com/itaymendel/zoekt-mcp/compare/v0.1.0...HEAD
