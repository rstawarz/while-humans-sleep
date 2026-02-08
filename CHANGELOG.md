# Changelog

All notable changes to While Humans Sleep will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-02-08

### Added
- **Pause/Resume commands**: `whs pause` and `whs resume` CLI commands to control the running dispatcher
  - Signal-based: sends SIGUSR1/SIGUSR2 to dispatcher process (follows existing `whs stop` pattern)
  - Dispatcher registers signal handlers on start, cleans them up on shutdown
  - Guards against already-paused/not-paused states
- **Telegram commands**: `/pause`, `/resume`, `/status` bot commands for remote dispatcher control
  - CommandHandler registered before QuestionHandler so commands take priority
  - `/status` shows running/paused state, PID, and active work count

## [0.3.1] - 2025-02-07

### Fixed
- **Handoff mechanism**: Replaced broken SDK-based `forceHandoffViaTool` (used unregistered Handoff tool, wrong runner) with reliable 3-tier approach:
  1. **File-based**: `whs handoff` CLI command writes `.whs-handoff.json` (persists across crashes)
  2. **Output parsing**: Parse handoff from agent text output (YAML/JSON blocks)
  3. **Resume fallback**: Resume session via actual agent runner with `maxTurns: 3` (was 1)
- **Agent prompt**: Now instructs agents to use `whs handoff` command as preferred handoff method
- Removed unused `HANDOFF_TOOL_SCHEMA` and `@anthropic-ai/claude-agent-sdk` import from handoff module

### Added
- `whs handoff` CLI command for agents to record structured handoffs via Bash

## [0.3.0] - 2025-02-07

### Fixed
- **Dispatch race condition**: Duplicate agent launches when tick fires before async dispatch registers in activeWork. Now marks step `in_progress` synchronously before async dispatch and checks `runningAgents` map as a second guard.
- **Zombie detection**: Added reconciliation in every tick that detects activeWork entries with no running agent and resets them for retry.
- **Circuit breaker**: Dispatch retry loop protection via `dispatch-attempts:N` label on step beads. After 3 failed attempts, step is marked BLOCKED instead of endlessly retrying.

## [0.2.2] - 2025-02-07

### Fixed
- Telegram completion notifications failed with MarkdownV2 parse error on cost value (unescaped `.` in `$0.0000`)

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
