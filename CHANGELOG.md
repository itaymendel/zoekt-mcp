# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

- **CORS is removed.** The server sends no `Access-Control-*` headers and answers no preflight; a request with a foreign `Origin` gets 403, so browser-based clients are unsupported. `MCP_ALLOWED_ORIGINS` is removed (only localhost origins are accepted).
- **`--timeout` / `ZOEKT_TIMEOUT_MS` are removed.** The Zoekt request timeout is a fixed 30 seconds.
- **`search` no longer takes `maxMatchesPerFile`.** Every matching line of a shown file is printed.

### Changed

- The request body cap (1 MiB) is enforced by the MCP SDK only: an oversized `Content-Length` gets a 4xx response.
- `search` output has a single 20,000-character cap (the first file is always shown) and a `[output truncated]` marker when it cuts; the truncation footer is one line, `Showing N of M files; narrow with r:/f:/lang:` ("at least M" only when Zoekt sent no stats).
- `read_file` footers are reduced to four: empty file, past the end, `Truncated: showing lines X-Y of N. Continue with startLine=Z.` and `End of file.`. The 40,000-character cut uses the same `Truncated` footer ("of at least N" when the 8 MiB fetch cap cut the file). The clamped-range note and the fetch-limit messages are gone, and the ambiguous-branch error no longer carries the known-limitation text.
- `read_file` "not indexed" errors quote Zoekt's own reason ("contains binary content", "exceeds the maximum size limit"); an HTML response from either Zoekt endpoint gets one message. Messages for Zoekt's 418 responses are unchanged.
- `list_repos` output is unchanged.

## [1.0.0-alpha.0] - 2026-10-13

First 1.0 prerelease, published under the `next` dist-tag (`npx -y zoekt-mcp@next`); `latest` stays at 0.1.0. Migrating from 0.1.x: see the Breaking notes below.

### Breaking

- **`file_content` is replaced by `read_file`** (no alias): `repository` -> `repo`, `filePath` -> `path`, new `startLine` / `endLine`. Output is numbered (`# <repo>`, `## <path>  (N lines)`, `N:text` rows and a footer); 500 lines by default, 2000 at most, 40,000 characters at most, lines over 2000 characters are clipped. A named `branch` must be an indexed branch (`HEAD` is the default branch). Missing files and repositories, ambiguous branches and files Zoekt did not index (binary or too large) get clear errors.
- **`search` output is rewritten.** Results are grouped as `# <repo>` then `## <path>`; rows are `N:text` for matches and `N-text` for context, with `--` between non-adjacent groups. `Language:`, `Branches: HEAD` and `Stats:` are removed; branches appear only when they differ between files, and the footer after `---` gives totals or says what was truncated. Parse rows with `^(\d+)([:-])`.
- **`search` parameter `limit` is replaced by `maxFiles`** (1-100, default 20; `limit` was default 30). `contextLines` now defaults to 2 (was 3); unknown keys are ignored and `query` must not be empty.
- **`list_repos` is reworked.** `filter` is an unanchored, case-insensitive regex on the repository name; new `limit` (1-200, default 50) and `offset`; one line per repository, sorted by name, with a paging footer.
- **HTTP is stateless Streamable HTTP at `POST /mcp`.** `GET /sse` and `POST /messages` return 410 Gone, `/health` and `/` are removed (use `/healthz`) and the CORS wildcard is removed. SSE-only clients need a bridge such as `mcp-remote`, or stdio.
- **Safer defaults.** The transport is never auto-detected (stdio unless `--transport http` / `MCP_TRANSPORT=http`); HTTP binds to `127.0.0.1` (was `0.0.0.0`) and a non-loopback bind needs `MCP_AUTH_TOKEN` / `MCP_AUTH_TOKEN_FILE` or `MCP_ALLOW_UNAUTHENTICATED=true`, otherwise it exits 2; `Host` and `Origin` validation on `/mcp` is always on (403); request bodies are capped at 1 MiB.
- **`ZOEKT_URL` / `--url` must be an `http://` or `https://` URL.**
- **Requirements and packaging.** Node.js >= 22 (was >= 18) and a Zoekt webserver from 2025-01-30 or later (`read_file` uses `/print?format=raw`). The package has zero runtime dependencies and is CLI-only (`main` is removed).

### Added

- Server `instructions` and title, tool titles and read-only annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint: false`, `openWorldHint: false`) on `search`, `list_repos` and `read_file`.
- `GET /healthz` (process liveness; never touches Zoekt).
- `MCP_ALLOWED_HOSTS`, `MCP_AUTH_TOKEN` / `MCP_AUTH_TOKEN_FILE` and `MCP_ALLOW_UNAUTHENTICATED` for the HTTP transport.
- Exit code 2 for usage and configuration errors, with a readable message on stderr (was a JSON log line and exit 1). Empty or whitespace-only environment variables are treated as unset.
- Real context lines in `search` (`contextLines`, default 2) and `search` output bounded to about 20,000 characters (the first file is always shown), with a footer that reports exactly how many files were left out and why ("showing 3 of 8 files", "of at least N" when Zoekt skipped files or shards).
- Cancellation: a client abort now cancels the in-flight Zoekt request.
- Network errors name the cause: `Cannot reach Zoekt at <URL> (ECONNREFUSED)`, `Zoekt request timed out after <ms>ms`. Tool errors include Zoekt's error text (query parse errors, HTTP failures, unexpected responses); long bodies are truncated at 500 characters.
- Graceful shutdown: SIGINT/SIGTERM stop accepting connections, wait up to 10 seconds, then drop what is left and exit 0; a second signal exits 1 immediately.
- README rewrite: quick start, client setup, security, configuration, troubleshooting and the manual release runbook.

### Changed

- Tool descriptions are rewritten to match real Zoekt behavior (smart-case, case-sensitive `r:`, no `l:` short form, `branch:HEAD`, quoting inside quotes) and teach `sym:` (needs a ctags-built index) and `type:file`; parameter descriptions are shorter.
- `--help` is shorter (21 lines) and lists the environment variables that have no flag.
- Migrated to MCP TypeScript SDK v2; stdio is served via `serveStdio` and HTTP via `createMcpHandler` (both speak 2025-11-25 and 2026-07-28).
- The startup log redacts credentials in `ZOEKT_URL`.

### Fixed

- `list_repos` always failed with a schema error (it sent a `type:repo` query, which Zoekt answers with a different response shape); it now uses an `r:` repository listing.
- `search` honours `contextLines` (context lines were fetched but never shown), no longer strips indentation, prints a line with several matches once, and no longer reports the duration in the wrong unit (it was nanoseconds divided by 1000 and labelled ms; the line is removed).
- Zoekt's `418` responses are no longer shown as "I'm a teapot": a missing file is reported as not found and several differing versions as ambiguous, each with a clear message.
- Search no longer fails on `null` arrays/fields in Zoekt's JSON (`FileMatches`, `Fragments`, `Repos`, `Metadata`, missing `Language`, `Stats`, `RepoURLs`).
- A repo-only `search` query (only `r:` filters) now reports that Zoekt answered with a repository listing instead of failing with a schema error.
- A `ZOEKT_URL` with credentials no longer fails on Node.
- The logger no longer depends on a worker thread whose path was baked into the bundle at build time; stderr logging now works when installed from npm and the process exits promptly when stdin closes.

### Security

- Credentials in `ZOEKT_URL` (`http://user:pass@host`) are sent as HTTP Basic auth and never appear in errors or logs.
- HTTP is secure by default: loopback bind, mandatory token for non-loopback binds, always-on Host/Origin validation (DNS-rebinding protection), optional bearer auth compared in constant time, request body cap, and the token is redacted from logs. `/healthz` is exempt from these checks.

[Unreleased]: https://github.com/itaymendel/zoekt-mcp/compare/v1.0.0-alpha.0...HEAD
[1.0.0-alpha.0]: https://github.com/itaymendel/zoekt-mcp/compare/v0.1.0...v1.0.0-alpha.0
