# Changelog

All notable changes to While Humans Sleep will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.2] - 2026-02-10

### Fixed
- **CI poller never found pending steps**: `bd list --json` (like `bd ready --json`) doesn't include the `parent` field. `getStepsPendingCI()` relied on `bead.parent` to resolve the project, so every step was silently filtered out. Now falls back to `bd show` to resolve the parent epic, matching the existing pattern in `getReadyWorkflowSteps()`

## [0.9.1] - 2026-02-10

### Fixed
- **Silent pause on startup**: Dispatcher loaded persisted `paused` state from a previous session but never logged it, making it appear to start successfully while doing nothing. Now emits a warning on startup when paused

## [0.9.0] - 2026-02-10

### Fixed
- **CI poller broken**: `getGitHubCIStatus()` and `getPRMergeability()` ran `gh` commands without `cwd`, so they targeted the WHS repo instead of the project repo. PRs stayed `ci:pending` forever. Now resolves each step's project and passes the correct repo path to all `gh` calls
- **`/status <step>` only showed active work**: `getStepDetail()` only searched the in-memory `activeWork` map, so pending, blocked, completed, and errored workflows returned "No active work found"

### Added
- **Bead-based step detail**: `/status` and `whs status` now query orchestrator beads when a step isn't actively running, showing workflow status, step history, PR links, and cost data
- **Multi-format status queries**: Step detail now accepts step IDs (`orc-zwx.3`), source beads (`bridget_ai/bai-zv0.4`), PR URLs (`https://github.com/.../pull/46`), and PR shorthand (`pr:46`, `#46`)
- **`project` field on `PendingCIStep`**: CI poller steps now carry their project name, resolved from the parent epic's labels

## [0.8.3] - 2026-02-09

### Added
- **Merge conflict detection**: CI poller now checks PR mergeability via `gh pr view --json mergeable` before checking CI status. PRs with merge conflicts are routed to implementation to resolve them, instead of being treated as "passed" (which happened when no CI checks ran)

## [0.8.2] - 2026-02-09

### Fixed
- **Metrics FK constraint**: Workflows started before metrics were wired up caused `FOREIGN KEY constraint failed` when dispatching their next step. `recordStepStart` now auto-creates a placeholder workflow row if missing
- **Telegram MarkdownV2 escaping**: Agent names with underscores (e.g. `release_manager`) broke Telegram status messages — now properly escaped
- **Duplicate log message**: Removed duplicate "Telegram bot started" log (service and CLI both logged it)

## [0.8.1] - 2026-02-09

### Added
- **Per-step status detail**: `whs status <step>` and Telegram `/status <step>` show detailed info for a specific active step — title, agent, duration, cost, PR link, and recent agent activity log
- **Agent activity logging** (`src/agent-log.ts`): Compact JSONL logs at `.whs/logs/{stepId}.jsonl` written via dispatcher `onOutput`/`onToolUse` callbacks. Cleaned up on dispatcher start
- **Agent log tests** (`src/agent-log.test.ts`): 16 tests covering write, read, truncation, limit, and cleanup

### Changed
- Dispatcher now logs agent start/tool/text/end events during execution for real-time visibility

## [0.8.0] - 2026-02-09

### Added
- **Shared status module** (`src/status.ts`): Single source of truth for status data, eliminating duplicate logic between CLI `whs status` and Telegram `/status`
- **PR links in status**: Active work items with associated PRs now show clickable links (GitHub URL derived from git remote). Visible in both CLI verbose output and Telegram status messages

### Changed
- CLI `whs status` and Telegram `/status` now use the same `getStatusData()` function for consistent output
- CLI status now shows uptime, step number, and today's cost in default (non-verbose) view

## [0.7.1] - 2026-02-09

### Fixed
- **Turn limit handling**: Agents that hit the turn limit but produced a valid handoff were incorrectly marked BLOCKED. Now parses handoff before checking turn limit, honoring valid handoffs even at the limit
- **Metrics not recording**: `recordWorkflowStart`, `recordStepStart`, `recordStepComplete`, and `recordWorkflowComplete` were never called from the dispatcher — metrics DB was always empty. Now wired up at all lifecycle points (runner-agnostic)

### Changed
- **Turn limit raised**: `MAX_AGENT_TURNS` increased from 50 to 500 — complex implementation tasks routinely need 40-60+ turns, 50 was too restrictive

## [0.7.0] - 2026-02-09

### Added
- **Structured code review format**: New `docs/llm/code-review-output-format.md` defines a PASS/NEEDS_CHANGES verdict with Critical/Major/Minor severity levels for CI code reviews
- **Quality review agent update**: Parses structured review format, defaults to cautious routing (`implementation`) when feedback is ambiguous instead of sending straight to `release_manager`
- **Review setup module** (`src/review-setup.ts`): Propagates review format doc and CI prompt into managed projects, finds and updates claude-code-action workflows
- **`whs setup review [project]` command**: Standalone CLI command to set up review format in a project, with `--write` flag for non-interactive use
- **`whs add` integration**: Review format setup offered as optional step during interactive project onboarding

### Fixed
- **Workflow step parent resolution**: `bd ready --json` doesn't include the `parent` field, causing "Cannot resolve project for step" errors on every tick. Now falls back to `bd show` to resolve the parent epic when missing

## [0.6.0] - 2026-02-09

### Added
- **PR feedback routing**: After CI passes for the first time, the workflow now routes back to the implementation agent to address PR comments before quality review
  - Tracked via `pr-feedback:addressed` label on the workflow epic — only redirects once
  - New `epicHasLabel()` and `addEpicLabel()` workflow helpers
  - `PendingCIStep` now includes `agent` field for routing decisions
- **Implementation agent PR feedback docs**: New "If Addressing PR Feedback" section in agent definition with instructions to check `gh pr view --json comments,reviews` and self-review the diff

## [0.5.0] - 2026-02-08

### Added
- **Errored workflow recovery**: Auth errors now use `errored:auth` label instead of `blocked:human`, distinguishing transient failures from legitimately stuck work
  - Auto-recovery on startup: after preflight passes, errored workflows are automatically retried
  - Auto-recovery on resume: same recovery runs after successful resume preflight
  - `whs retry [epic-id]` CLI command: manual escape hatch for any blocked/errored workflow
- **New workflow functions**: `errorWorkflow()`, `getErroredWorkflows()`, `retryWorkflow()` in workflow module

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
