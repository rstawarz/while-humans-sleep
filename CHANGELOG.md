# Changelog

All notable changes to While Humans Sleep will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.7] - 2026-02-15

### Fixed
- **Telegram bot crash kills entire dispatcher**: Grammy `bot.start()` polling errors (e.g., 409 Conflict from duplicate bot instances) were unhandled rejections that crashed the Node process. Now caught gracefully — Telegram degrades while the dispatcher continues
- **Stale lock file blocks restart after crash**: Added `process.on('exit')` and `uncaughtException`/`unhandledRejection` handlers to always release the dispatcher lock file on unexpected crashes

## [0.13.6] - 2026-02-15

### Fixed
- **`whs retry` fails with UNIQUE constraint on step_runs**: Retrying a workflow reuses the same step ID, but `recordStepStart` used `INSERT INTO` which fails on duplicate keys. Now uses `INSERT OR REPLACE` to handle retried steps

## [0.13.5] - 2026-02-15

### Added
- **Claude auth check in `whs doctor`**: Verifies Claude authentication before starting. For CLI runner, checks that `claude` is in PATH and responds to a prompt. For SDK runner, checks that `ANTHROPIC_API_KEY` is available. The dispatcher preflight now uses the same `checkClaudeAuth()` function so both report consistently

## [0.13.4] - 2026-02-15

### Fixed
- **Reopened epics spawn duplicate workflows**: When an epic was reopened (after fixing premature closure), it appeared in `bd ready` and the dispatcher created a new planner workflow for it, even though its children were already being worked on. Now skips epics that already have children in `pollProjectBacklogs`

## [0.13.3] - 2026-02-15

### Fixed
- **Premature epic closure on workflow completion**: When a workflow completed with DONE, the dispatcher closed the source bead unconditionally — even if it was an epic with open children (e.g., after a planner created stories). This unblocked downstream dependencies prematurely. Now checks for open children before closing, and preserves the worktree for remaining work

## [0.13.2] - 2026-02-15

### Fixed
- **Worktrees created from stale local branch**: `ensureWorktree` branched from the local base branch, which could be behind `origin` and missing merged dependency PRs. Now fetches origin before creating the worktree and uses `origin/<baseBranch>` as the base ref

## [0.13.1] - 2026-02-15

### Fixed
- **CLI session resume always fails for question answers**: `claude --resume` treats stdin as a new user message, not as a tool result for the pending `AskUserQuestion`. Every question-answer flow wasted time on a doomed resume attempt before falling back. Now `CLIAgentRunner.resumeWithAnswer()` returns immediately, and the fallback prompt includes both the original questions and the answer for better agent context

## [0.13.0] - 2026-02-12

### Added
- **`whs plan --file` flag**: Feed an existing plan document to the planner agent. `whs plan --file docs/plans/ux-master-plan.md` reads the file and injects its content into the planning task so the planner agent receives the full plan as context, analyzes the codebase, and creates beads epics/tasks. Derives title from filename if no description given

## [0.12.2] - 2026-02-11

### Fixed
- **Session resume fails after question answered**: When a Claude CLI session expired between asking a question and receiving an answer, the resume produced no output and the workflow fell through to BLOCKED. Now detects empty resume output and falls back to a fresh agent run with the Q&A context injected into the prompt
- **Worktree cleanup still missed GitHub-merged branches**: `git fetch origin` only updates `origin/main`, not the local `main` ref. Worktrunk's `mainState` compares against local main, so merged branches still appeared as "ahead". Now uses `git merge-base --is-ancestor` against `origin/main` directly

## [0.12.1] - 2026-02-11

### Fixed
- **Planner agent wrote code instead of creating tasks**: Planner received the same prompt template as implementation agents (including "push to this branch" and PR handoff options), causing it to implement features instead of planning. Now skips worktree/branch framing, restricts handoffs to DONE/BLOCKED, adds explicit "do NOT write code" instructions, and injects the project epic ID
- **Worktree cleanup missed GitHub-merged branches**: `cleanupMergedWorktrees` relied on worktrunk's `mainState` which compares against the local main ref. Branches merged via GitHub PR appeared as "ahead" instead of "integrated". Now fetches origin before checking

## [0.12.0] - 2026-02-11

### Added
- **TUI dashboard**: `whs start` now renders an ink-based terminal dashboard showing agent panels, log stream, and status bar. Use `--no-tui` for plain console output. Adds `Logger` interface to abstract dispatcher output
- **Auto-cleanup merged worktrees**: Dispatcher periodically removes worktrees whose branches are integrated into main (every ~5 min alongside daemon health checks)

### Fixed
- **Telegram emoji rendering**: `/doctor` and `/retry` commands showed literal `u2705` text instead of emoji — now uses actual Unicode characters

## [0.11.0] - 2026-02-11

### Added
- **Telegram `/doctor` command**: Run health checks from Telegram — shows beads daemons, daemon errors, errored/blocked workflows, CI-pending PRs, worktrees, and state sanity with pass/warn/fail icons
- **Telegram `/retry` command**: Retry errored workflows from Telegram — `/retry` auto-retries all errored workflows, `/retry <id>` retries a specific epic (supports both epic IDs and source bead IDs)

## [0.10.3] - 2026-02-11

### Fixed
- **Worktree not cleaned up after workflow completion**: `completeWorkflowSuccess` passed the step ID (e.g., `orc-pds.5`) to `removeWorktree` instead of the source bead ID (e.g., `bai-zv0.6`) which is used as the branch/worktree name. Completed workflows left worktrees behind indefinitely
- **Retry workflow fails when all steps are closed**: `retryWorkflow()` used `beads.list` with `--parent` filter which doesn't return closed children, so retrying a workflow where the only step had failed produced no new step — leaving the workflow stranded. Now uses `bd show` to get all dependents (including closed) and creates a new step when all steps are closed
- **Answered questions never resumed**: Steps paused for questions stayed `in_progress`, but `getReadyWorkflowSteps()` only returned `open` steps. Answered questions were never picked up by the tick loop. Now resets the step to `open` when a question is asked — the question bead blocks it via dependency, and it naturally unblocks when the question is answered

## [0.10.2] - 2026-02-10

### Fixed
- **Doctor worktree check too noisy**: Open PRs, merged PRs, and unknown worktrees were triggering warnings even though the system can handle them or they're harmless cleanup candidates. Now only warns when manual intervention is actually needed

## [0.10.1] - 2026-02-10

### Fixed
- **Doctor worktree check showed false positives**: `checkOrphanedWorktrees` filtered on `whs:workflow` label that was never added to workflow epics, so all worktrees appeared unmanaged. Now lists all orchestrator epics and checks PR status via `gh pr list` to categorize worktrees as: active, open PR (needs review/merge), merged (safe to remove), or no PR
- **Missing `whs:workflow` label on workflow epics**: `startWorkflow()` never added the label. Now included in epic creation
- **Handoff fallback had no diagnostics**: When an agent failed to produce a handoff, the BLOCKED context was generic. Now includes the last 20 lines of agent output for debugging
- **Doctor showed blocked workflows without reason**: Now reads the last "Blocked:" comment from the workflow to show why it was blocked
- **Beads-sync worktrees were false positive orphans**: Internal `.git/beads-worktrees/beads-sync` worktrees are now excluded from the check
- **Doctor pluralization**: "1 warning(s)" → "1 warning"

## [0.10.0] - 2026-02-10

### Added
- **`whs doctor` command**: Pre-start health check that verifies beads daemons, daemon errors, errored/blocked workflows, CI-pending PR status, orphaned worktrees, and state sanity. Exit code 1 on failures
- **Branch name in agent prompts**: Agents now see their worktree branch name in an `## Environment` section, with instructions not to rename or switch branches. Prevents agents from renaming branches (e.g., `bai-zv0.6` → `feature/action-items-task-view`) which caused worktree resolution failures

## [0.9.3] - 2026-02-10

### Fixed
- **Worktree creation fails when branch already exists**: `ensureWorktree()` checked for existing worktrees but not bare branches. When a branch existed from a previous agent run without a checked-out worktree, `wt switch --create` failed. Now falls back to `wt switch` (without `--create`) when the branch already exists

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
