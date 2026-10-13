# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, `MCP_AUTH_TOKEN` / `MCP_AUTH_TOKEN_FILE`, `MCP_ALLOW_UNAUTHENTICATED`, `MCP_MAX_BODY_BYTES` and `MCP_SHUTDOWN_TIMEOUT_MS` for the HTTP transport.
- Server `instructions`, a server title, tool titles and read-only annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint: false`, `openWorldHint: false`) on all tools, and one-hour `tools/list` / `server/discover` cache hints for 2026-era clients (`private` when `MCP_AUTH_TOKEN` / `MCP_AUTH_TOKEN_FILE` is set, else `public`).
- Graceful shutdown: SIGINT/SIGTERM stop accepting connections, wait up to `MCP_SHUTDOWN_TIMEOUT_MS`, then drop what is left; exit 0 when clean, 1 when forced, and a second signal exits 1 immediately.

### Changed

- **BREAKING:** `search` output is rewritten. Results are grouped as `# <repo>` then `## <path>` (was `## <repo>/<path>`); rows are `N:text` for matches and `N-text` for context (was `> N: text`); `--` separates non-adjacent groups; indentation is kept and a line with several matches prints once instead of as several garbled rows. `Language:`, `Branches: HEAD` and the `Stats:` line are removed; branches appear only when they differ between files, and the footer after `---` gives file and match totals or says what was truncated. Migration: parse rows with `^(\d+)([:-])`; pass `# repo` and `## path` as `repo` and `path` to `read_file`.
- **BREAKING:** `search` parameter `limit` is replaced by `maxFiles` (1-100, default 20; `limit` was default 30). New `maxMatchesPerFile` (1-50, default 5) and `contextLines` now defaults to 2 (was 3). `limit` is no longer accepted (it is ignored). `query` must not be empty.
- `search` output is bounded to about 20,000 characters (the first file is always shown), and the footer reports exactly how many files were left out and why ("showing 3 of 8 files", "of at least N" when Zoekt skipped files or shards).
- **BREAKING:** `list_repos` now works (it always failed before). `filter` is an unanchored, case-insensitive regex on the repository name (prefix with `(?-i)` for case-sensitive); new `limit` (1-200, default 50) and `offset` parameters; output is one line per repository (`name  branch@sha7, ...  N files  size  indexed date`) sorted by name, with a paging footer.
- Tool descriptions are rewritten to match real Zoekt behavior (smart-case, case-sensitive `r:`, no `l:` short form, `branch:HEAD`, quoting inside quotes) and now teach `sym:` (needs a ctags-built index) and `type:file`; parameter descriptions are shorter.
- Tool errors now include Zoekt's error text (query parse errors, HTTP failures, unexpected responses) instead of "418 I'm a teapot"; long bodies are truncated at 500 characters.
- Clear error when Zoekt is unreachable (`Cannot reach Zoekt at <URL> (ECONNREFUSED)`) or too slow (`Zoekt request timed out after <ms>ms`); client cancellation now aborts the Zoekt request.
- **BREAKING:** `file_content` is replaced by `read_file` (no alias). Parameters are renamed (`repository` -> `repo`, `filePath` -> `path`) and `startLine` / `endLine` are new. Output is numbered (`# <repo>`, `## <path>  (N lines)`, `N:text` rows, then `End of file.` or `Truncated: ... Continue with startLine=K.`); a call returns 500 lines by default (2000 at most, wider ranges are clamped with a note), at most 40,000 characters, and lines over 2000 characters are clipped. At most 8 MiB of a file is read (the stream is cancelled at the cap). A named `branch` must be an indexed branch (checked first, listing the indexed branches otherwise); `branch: "HEAD"` reads the default branch. Zoekt matches `branch` as a case-sensitive substring, so `main` can also match `main-old`; when that makes a file ambiguous the error lists the indexed branches. Missing files and repositories, several differing versions across branches (`Pass branch.`), and files Zoekt did not index as binary or too large (`NOT-INDEXED`) get clear errors instead of being returned as content.

  | Before | After |
  | --- | --- |
  | `file_content` | `read_file` |
  | `{"repository":"o/r","filePath":"a.ts"}` | `{"repo":"o/r","path":"a.ts"}` |
  | `{"repository":"o/r","filePath":"a.ts","branch":"dev"}` | `{"repo":"o/r","path":"a.ts","branch":"dev"}` |
  | whole file, unnumbered | `{"repo":"o/r","path":"a.ts","startLine":501,"endLine":700}` |
- The startup log redacts credentials in `ZOEKT_URL`.
- **BREAKING:** the transport is never auto-detected; the default is stdio unless `--transport http` / `MCP_TRANSPORT=http`. If you relied on a TTY selecting HTTP, add `--transport http`.
- **BREAKING:** `ZOEKT_URL` / `--url` must be an `http://` or `https://` URL.
- **BREAKING:** the default bind address is now `127.0.0.1` (was `0.0.0.0`). Containers must set `MCP_HOST=0.0.0.0` and `MCP_AUTH_TOKEN` / `MCP_AUTH_TOKEN_FILE` (or `MCP_ALLOW_UNAUTHENTICATED=true`); a non-loopback bind without a token refuses to start (exit 2).
- **BREAKING:** `Host` and `Origin` validation on `/mcp` is always on (403); hostnames are matched without ports. Request bodies over 1 MiB get 413 (`MCP_MAX_BODY_BYTES`). `Access-Control-Allow-Origin` is only sent for origins listed in `MCP_ALLOWED_ORIGINS`.
- Empty or whitespace-only environment variables are treated as unset.
- Configuration and CLI usage errors (including unknown options) print a readable message to stderr and exit 2 (was a JSON log line and exit 1).
- **BREAKING:** Node.js >= 22 is required.
- Migrated to MCP TypeScript SDK v2; stdio is served via `serveStdio` (speaks 2025-11-25 and 2026-07-28).
- **BREAKING:** HTTP is now stateless Streamable HTTP at `POST /mcp`. `GET /sse` and `POST /messages` are removed (410 Gone); `/health` and `/` are removed, use `/healthz`; the CORS wildcard is removed. SSE-only clients need a bridge (e.g. `mcp-remote`) or stdio.
- The package has zero runtime dependencies (`npx zoekt-mcp` installs 1 package, was 113); `main` is removed (CLI-only).
- Real Zoekt fixtures (internal).
- CI now tests the built `dist/` on Node 22 and 24 with a stdio smoke test (internal).

### Removed

### Fixed

- `search` honours `contextLines` (context lines were fetched but never shown), no longer strips indentation, and no longer reports the duration in the wrong unit (it was nanoseconds divided by 1000 and labelled ms; the line is removed).
- A `ZOEKT_URL` with credentials no longer fails on Node.
- Search no longer fails on `null` arrays/fields in Zoekt's JSON (`FileMatches`, `Fragments`, `Repos`, `Metadata`, missing `Language`, `Stats`, `RepoURLs`); context lines (`Before`/`After`) are no longer stripped from the parsed response.
- A repo-only `search` query (only `r:` filters) now reports that Zoekt answered with a repository listing instead of failing with a schema error.
- Logger no longer depends on a worker thread whose path was baked into the bundle at build time; stderr logging now works when installed from npm and the process exits promptly when stdin closes.

### Security

- Credentials in `ZOEKT_URL` (`http://user:pass@host`) are sent as HTTP Basic auth and never appear in errors or logs.
- HTTP is secure by default: loopback bind, mandatory token for non-loopback binds, always-on Host/Origin validation (DNS-rebinding protection), optional bearer auth compared in constant time, request body cap, and the token is redacted from logs. `/healthz` is exempt from these checks.
