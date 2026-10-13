# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

- Real Zoekt fixtures (internal).
- CI now tests the built `dist/` on Node 22 and 24 with a stdio smoke test (internal).

### Removed

### Fixed

- Logger no longer depends on a worker thread whose path was baked into the bundle at build time; stderr logging now works when installed from npm and the process exits promptly when stdin closes.

### Security
