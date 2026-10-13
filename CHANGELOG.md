# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-alpha.0] - 2026-10-13

First 1.0 prerelease, published under the `next` dist-tag (`npx -y zoekt-mcp@next`); `latest` stays at 0.1.0. See "Migrating from 0.1.x" in the README.

### Breaking

- **`file_content` is replaced by `read_file`** (no alias). Parameters are renamed (`repository` -> `repo`, `filePath` -> `path`) and `startLine` / `endLine` are new. Output is numbered (`# <repo>`, `## <path>  (N lines)`, `N:text` rows, then `End of file.` or `Truncated: ... Continue with startLine=K.`); a call returns 500 lines by default (2000 at most, wider ranges are clamped with a note), at most 40,000 characters, and lines over 2000 characters are clipped. At most 8 MiB of a file is read (the stream is cancelled at the cap). A named `branch` must be an indexed branch (checked first, listing the indexed branches otherwise); `branch: "HEAD"` reads the default branch. Zoekt matches `branch` as a case-sensitive substring, so `main` can also match `main-old`; when that makes a file ambiguous the error lists the indexed branches. Missing files and repositories, several differing versions across branches (`Pass branch.`), and files Zoekt did not index as binary or too large (`NOT-INDEXED`) get clear errors instead of being returned as content.

  | Before | After |
  | --- | --- |
  | `file_content` | `read_file` |
  | `{"repository":"o/r","filePath":"a.ts"}` | `{"repo":"o/r","path":"a.ts"}` |
  | `{"repository":"o/r","filePath":"a.ts","branch":"dev"}` | `{"repo":"o/r","path":"a.ts","branch":"dev"}` |
  | whole file, unnumbered | `{"repo":"o/r","path":"a.ts","startLine":501,"endLine":700}` |
- **`search` output is rewritten.** Results are grouped as `# <repo>` then `## <path>` (was `## <repo>/<path>`); rows are `N:text` for matches and `N-text` for context (was `> N: text`); `--` separates non-adjacent groups; indentation is kept and a line with several matches prints once instead of as several garbled rows. `Language:`, `Branches: HEAD` and the `Stats:` line are removed; branches appear only when they differ between files, and the footer after `---` gives file and match totals or says what was truncated. Migration: parse rows with `^(\d+)([:-])`; pass `# repo` and `## path` as `repo` and `path` to `read_file`.
- **`search` parameter `limit` is replaced by `maxFiles`** (1-100, default 20; `limit` was default 30). New `maxMatchesPerFile` (1-50, default 5); `contextLines` now defaults to 2 (was 3). `limit` is no longer accepted (it is ignored). `query` must not be empty.
- **`list_repos` is reworked.** `filter` is an unanchored, case-insensitive regex on the repository name (prefix with `(?-i)` for case-sensitive); new `limit` (1-200, default 50) and `offset` parameters; output is one line per repository (`name  branch@sha7, ...  N files  size  indexed date`) sorted by name, with a paging footer.
- **HTTP is now stateless Streamable HTTP at `POST /mcp`.** `GET /sse` and `POST /messages` are removed (410 Gone, with a hint to use `/mcp`); `/health` and `/` are removed, use `/healthz`; the CORS wildcard is removed. SSE-only clients need a bridge (e.g. `mcp-remote`) or stdio.
- **The transport is never auto-detected.** The default is stdio unless `--transport http` / `MCP_TRANSPORT=http`. If you relied on a TTY selecting HTTP, add `--transport http`.
- **The default bind address is `127.0.0.1`** (was `0.0.0.0`). Containers must set `MCP_HOST=0.0.0.0` and `MCP_AUTH_TOKEN` / `MCP_AUTH_TOKEN_FILE` (or `MCP_ALLOW_UNAUTHENTICATED=true`); a non-loopback bind without a token refuses to start (exit 2).
- **`Host` and `Origin` validation on `/mcp` is always on** (403); hostnames are matched without ports. Request bodies over 1 MiB get 413 (`MCP_MAX_BODY_BYTES`). `Access-Control-Allow-Origin` is only sent for origins listed in `MCP_ALLOWED_ORIGINS`.
- **`ZOEKT_URL` / `--url` must be an `http://` or `https://` URL.**
- **Node.js >= 22 is required** (was >= 18).
- **Minimum Zoekt version:** `read_file` uses `/print?format=raw`, so `zoekt-webserver` must be from 2025-01-30 or later.
- **Bundled dependencies:** the package has zero runtime dependencies (it was `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `pino` and `zod`); `main` is removed, the package is CLI-only.

### Added

- Server `instructions` and title, tool titles and read-only annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint: false`, `openWorldHint: false`) on `search`, `list_repos` and `read_file`, and one-hour `tools/list` / `server/discover` cache hints for 2026-era clients (`private` when `MCP_AUTH_TOKEN` / `MCP_AUTH_TOKEN_FILE` is set, else `public`).
- `GET /healthz` (process liveness; never touches Zoekt).
- `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, `MCP_AUTH_TOKEN` / `MCP_AUTH_TOKEN_FILE`, `MCP_ALLOW_UNAUTHENTICATED`, `MCP_MAX_BODY_BYTES` and `MCP_SHUTDOWN_TIMEOUT_MS` for the HTTP transport.
- Exit code 2 for usage and configuration errors, with a readable message on stderr (was a JSON log line and exit 1). Empty or whitespace-only environment variables are treated as unset.
- Real context lines in `search` (`contextLines`, default 2) and `search` output bounded to about 20,000 characters (the first file is always shown), with a footer that reports exactly how many files were left out and why ("showing 3 of 8 files", "of at least N" when Zoekt skipped files or shards).
- Cancellation: a client abort now cancels the in-flight Zoekt request.
- Network errors name the cause: `Cannot reach Zoekt at <URL> (ECONNREFUSED)`, `Zoekt request timed out after <ms>ms`. Tool errors include Zoekt's error text (query parse errors, HTTP failures, unexpected responses); long bodies are truncated at 500 characters.
- Graceful shutdown: SIGINT/SIGTERM stop accepting connections, wait up to `MCP_SHUTDOWN_TIMEOUT_MS`, then drop what is left; exit 0 when clean, 1 when forced, and a second signal exits 1 immediately.
- README rewrite: quick start, client setup, query cheat sheet, security, configuration, migration and troubleshooting, and the manual release runbook.

### Changed

- Tool descriptions are rewritten to match real Zoekt behavior (smart-case, case-sensitive `r:`, no `l:` short form, `branch:HEAD`, quoting inside quotes) and teach `sym:` (needs a ctags-built index) and `type:file`; parameter descriptions are shorter.
- `--help` is shorter (21 lines) and lists the environment variables that have no flag.
- Migrated to MCP TypeScript SDK v2; stdio is served via `serveStdio` and HTTP via `createMcpHandler` (both speak 2025-11-25 and 2026-07-28).
- The startup log redacts credentials in `ZOEKT_URL`.
- Internal: real Zoekt fixtures for the tests; CI tests the built `dist/` on Node 22 and 24 with stdio and HTTP smoke tests and a package check.

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
[0.1.0]: https://github.com/itaymendel/zoekt-mcp/releases/tag/v0.1.0
