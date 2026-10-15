# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

- **`file_content` is replaced by `read_file`** (no alias): `repository` -> `repo`, `filePath` -> `path`, new `startLine` / `endLine`. Output is numbered lines, 500 by default and 2000 at most, capped at 40,000 characters (longer lines are clipped). `branch` must be an indexed branch (`HEAD` is the default branch). Missing files, ambiguous branches, and files Zoekt did not index (binary or too large) get clear errors.
- **`search` output is rewritten.** Results are grouped as `# <repo>` then `## <path>`; rows are `N:text` for matches and `N-text` for context, with `--` between non-adjacent groups, and a footer after `---` says what was cut. A file's branches show as `(branches: ...)` only when they are not just `HEAD`. Output is capped at about 20,000 characters (the first file is always shown). `Language:` and `Stats:` lines are gone.
- **`search` parameters:** `limit` is replaced by `maxFiles` (1-100, default 20), and `contextLines` is removed (always 2 lines around each match).
- **`list_repos` is reworked.** `filter` is an unanchored, case-insensitive regex on the repository name; new `limit` (1-200, default 50); one line per repository (name and branches), sorted by name.
- **HTTP is stateless Streamable HTTP at `POST /mcp`.** `GET /sse` and `POST /messages` are gone, so SSE-only clients need a bridge such as `mcp-remote`, or stdio. CORS is removed, so browser-based clients are unsupported.
- **Safer defaults.** The transport is never auto-detected (stdio unless `--transport http` / `MCP_TRANSPORT=http`). HTTP binds to `127.0.0.1` (was `0.0.0.0`), and a non-loopback `MCP_HOST` requires `MCP_AUTH_TOKEN` or the server refuses to start.
- **Removed settings:** the `--host` and `--log-level` flags (use `MCP_HOST` and `LOG_LEVEL`) and `--timeout` / `ZOEKT_TIMEOUT_MS` (the Zoekt request timeout is a fixed 30 seconds).
- **`ZOEKT_URL` / `--url` must be an `http://` or `https://` URL.**
- **Requirements.** Node.js >= 22 (was >= 18) and a Zoekt webserver from 2025-01-30 or later. The package is CLI-only (`main` is removed).

### Added

- **`search_syntax` tool:** the full Zoekt query-language guide, served on demand by section. A query Zoekt rejects points to it.
- **Shared deployments:** `MCP_AUTH_TOKEN` bearer auth for the HTTP transport and `GET /healthz` for liveness probes.
- Server instructions, titles, and read-only annotations on all tools.
- Cancellation: a client abort cancels the in-flight Zoekt request.
- Clear errors: `Cannot reach Zoekt at <URL> (ECONNREFUSED)`, `Zoekt request timed out after <ms>ms`, Zoekt's own text for bad queries, and a readable message (exit code 1) for invalid flags or environment values.
- Graceful shutdown on SIGINT/SIGTERM.

### Changed

- Tool descriptions match real Zoekt behavior (smart-case, case-sensitive `r:`, `branch:HEAD`).

### Fixed

- `list_repos` always failed with a schema error.
- `search` no longer fails on `null` fields in Zoekt's JSON, and no longer strips indentation.
- A `ZOEKT_URL` with credentials works on Node.

### Security

- Credentials in `ZOEKT_URL` are sent as HTTP Basic auth, and neither they nor query strings appear in errors or logs.
- HTTP is secure by default: loopback bind, mandatory token for any other bind, constant-time bearer auth, `Host` and `Origin` validation on loopback, and a 1 MiB request body cap.

[Unreleased]: https://github.com/itaymendel/zoekt-mcp/compare/v0.1.0...HEAD
