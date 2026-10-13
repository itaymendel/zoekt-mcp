# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

- **BREAKING:** Node.js >= 22 is required.
- Migrated to MCP TypeScript SDK v2; stdio is served via `serveStdio` (speaks 2025-11-25 and 2026-07-28).
- **BREAKING:** HTTP is now stateless Streamable HTTP at `POST /mcp`. `GET /sse` and `POST /messages` are removed (410 Gone); `/health` and `/` are removed, use `/healthz`; the CORS wildcard is removed. SSE-only clients need a bridge (e.g. `mcp-remote`) or stdio.
- The package has zero runtime dependencies (`npx zoekt-mcp` installs 1 package, was 113); `main` is removed (CLI-only).
- Real Zoekt fixtures (internal).
- CI now tests the built `dist/` on Node 22 and 24 with a stdio smoke test (internal).

### Removed

### Fixed

- Logger no longer depends on a worker thread whose path was baked into the bundle at build time; stderr logging now works when installed from npm and the process exits promptly when stdin closes.

### Security
