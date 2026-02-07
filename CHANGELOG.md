# Changelog

All notable changes to While Humans Sleep will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2025-02-07

### Fixed
- Telegram messages rendered unicode escapes as literal text instead of emojis
- Notification messages now use `escapeMarkdownV2()` consistently

## [0.2.0] - 2025-02-07

### Added
- **Telegram Integration**: Bidirectional communication for question answering
  - Answer agent questions via text replies or inline buttons
  - Setup wizard: `whs telegram setup`
  - Commands: `whs telegram status/enable/disable`
  - Extensible handler pattern for future commands
  - SQLite-backed message store in metrics.db
- **Security**: Bot token stored in `.whs/.env` (gitignored), not config.json
- **CLI**: Version and build timestamp shown on startup

## [0.1.0] - 2025-02-06

### Added
- Initial release
- Multi-project dispatcher with beads integration
- Agent runner abstraction (CLI and SDK modes)
- Workflow orchestration with handoffs
- Question handling via beads
- CLI notifier
- Crash recovery via state persistence
- Metrics database for cost tracking
