# While Humans Sleep - Task List

> Generated from Claude Code session. Use this to track progress across sessions.

## Summary

- **Completed:** 1
- **Pending:** 18
- **Total:** 19

## Completed

### ✅ #1: Set up beads CLI wrapper
**Status:** completed

Create `src/beads/client.ts` that wraps the `bd` CLI commands:
- `ready(cwd)` - get ready tasks as JSON
- `show(id, cwd)` - get task details
- `create(title, opts, cwd)` - create task/epic
- `update(id, opts, cwd)` - update task
- `close(id, reason, cwd)` - close task
- `comment(id, text, cwd)` - add comment
- `sync(cwd)` - force sync
- `init(cwd, stealth?)` - initialize beads in a project

All methods should parse JSON output and return typed objects.

---

## Ready to Start (No Blockers)

### 📋 #2: Integrate worktrunk for worktree management
**Status:** pending | **Blocks:** #9

Use worktrunk (https://worktrunk.dev/) instead of raw git worktree commands.

Create `src/worktree.ts` that wraps worktrunk CLI:
- `ensureWorktree(project, beadId)` - use `wt switch -c {beadId}` to create worktree, return path
- `removeWorktree(project, beadId)` - use `wt remove {beadId}` to cleanup
- `listWorktrees(project)` - use `wt list` to get active worktrees
- `mergeWorktree(project, beadId)` - use `wt merge` for squash/rebase/cleanup after PR merge

Worktrunk handles path computation from branch names, reducing complexity.

Prerequisite: worktrunk must be installed (`npm install -g worktrunk` or via install script).

---

### 📋 #3: Implement config management
**Status:** pending | **Blocks:** #9, #10, #11

Create `src/config.ts` for managing `~/.whs/config.json`:
- `loadConfig()` - load and validate config
- `saveConfig(config)` - persist config
- `addProject(name, path, opts)` - add project to config
- `removeProject(name)` - remove project
- `getProject(name)` - get project by name

Also create the `~/.whs/` directory structure on first run.

---

### 📋 #4: Implement metrics database
**Status:** pending

Create `src/metrics.ts` using better-sqlite3:
- Initialize `~/.whs/metrics.db` with schema (workflow_runs, step_runs tables)
- `recordWorkflowStart(id, project, sourceBead)`
- `recordWorkflowComplete(id, status, totalCost)`
- `recordStepStart(id, workflowId, agent)`
- `recordStepComplete(id, cost, outcome)`
- Query methods for aggregations (per-project, per-agent, etc.)

---

### 📋 #5: Implement state persistence for crash recovery
**Status:** pending | **Blocks:** #9, #12, #13

Create `src/state.ts` for `~/.whs/state.json`:
- `loadState()` - load active work, pending questions
- `saveState(state)` - persist state
- `addActiveWork(work)` - track in-flight work
- `removeActiveWork(id)` - remove completed work
- `addPendingQuestion(question)` - track questions awaiting answers
- `removePendingQuestion(id)` - remove answered questions

State should be saved after every significant change for crash recovery.

---

### 📋 #6: Integrate Claude Agent SDK
**Status:** pending | **Blocked by:** #1 ✅ | **Blocks:** #7, #9, #13, #14

Create `src/agent-runner.ts`:
- Install `@anthropic-ai/claude-agent-sdk`
- `runAgent(agentFile, prompt, cwd, options)` - run agent via SDK query()
- Stream messages, capture sessionId, track cost
- Handle AskUserQuestion tool calls
- Return collected output and final cost

Must set `settingSources: ["project"]` to load CLAUDE.md.

---

### 📋 #8: Implement workflow orchestration
**Status:** pending | **Blocked by:** #1 ✅ | **Blocks:** #9

Create `src/workflow.ts`:
- `startWorkflow(project, sourceBead)` - create workflow epic in orchestrator beads, first step
- `createNextStep(epicId, agent, context)` - create next workflow step bead
- `completeStep(stepId, outcome)` - close step bead
- `completeWorkflow(epicId, result)` - close workflow epic, update source bead
- `getWorkflowContext(stepId)` - read step bead description for context injection

Orchestrator beads live in `config.orchestratorPath`.

---

### 📋 #15: Create/adapt agent definitions
**Status:** pending | **Blocks:** #18

Either copy from NEC or create new agent definitions:
- Implementation agent (senior engineer)
- Quality review agent
- Release manager agent
- UX specialist agent
- Architect agent (escalation)
- Planner agent (for planning workflow)

Agents need updated prompts for WHS context (beads for notes, handoff format, etc.)

---

### 📋 #16: Write unit tests for core modules
**Status:** pending

Create tests with vitest:
- `src/beads/client.test.ts` - mock execSync, test parsing ✅ (done with #1)
- `src/handoff.test.ts` - test YAML/JSON parsing, fallback logic
- `src/worktree.test.ts` - mock git commands
- `src/config.test.ts` - test load/save
- `src/state.test.ts` - test persistence

Use mocks for external commands (bd, git, SDK).

---

### 📋 #17: Research Gastown for beads best practices
**Status:** pending

Investigate https://github.com/steveyegge/gastown:
- Understand how Gastown teaches agents to use beads effectively
- Learn best practices for agent-bead interaction patterns
- Identify coaching approaches we should adopt for our own agents
- Document useful patterns for agent note-taking and memory

Apply learnings to our agent definitions.

---

### 📋 #19: Add prerequisite validation for `whs add`
**Status:** pending | **Blocks:** #10

Add validation step when projects are added via `whs add`:

**Prerequisites to validate:**
1. `wt --version` succeeds (worktrunk is installed)
2. `git --version` succeeds (git is installed)
3. Target path exists and is a valid git repository (`git rev-parse --git-dir`)

**Optional enhancements:**
- Suggest creating `.config/wt.toml` for project hooks (e.g., `post-create = "npm ci"`)
- Warn if worktree base directory isn't writable
- Check worktrunk version compatibility (if needed)

**Implementation location:** `src/config.ts` or new `src/validation.ts`

**Research notes (from worktrunk docs):**
- No `wt init` required - worktrunk works with any git repo
- Default worktree path: `{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}`
- Shell integration NOT needed for WHS (we pass `cwd` to execSync)
- Project hooks defined in `.config/wt.toml` are optional but useful

---

## Blocked Tasks

### 🚫 #7: Implement handoff parsing with trust-but-verify
**Status:** pending | **Blocked by:** #6 | **Blocks:** #9

Create `src/handoff.ts`:
- `tryParseHandoff(output)` - attempt to parse handoff from agent output (YAML or JSON block)
- `forceHandoffViaTool(sessionId, cwd)` - resume session and force Handoff tool call
- Define the Handoff custom tool schema
- `getHandoff(output, sessionId, cwd)` - main function that tries parse, falls back to tool

Returns typed Handoff object or throws if completely failed.

---

### 🚫 #9: Wire up dispatcher main loop
**Status:** pending | **Blocked by:** #2, #3, #5, #6, #7, #8 | **Blocks:** #18

Complete `src/dispatcher.ts`:
- Implement `getReadyWorkflowSteps()` using beads client
- Implement `pollProjectBacklogs()` using beads client
- Implement `startWorkflow()` using workflow module
- Implement `dispatchWorkflowStep()`:
  - Get context from workflow step
  - Ensure worktree
  - Run agent
  - Parse handoff
  - Create next step or complete workflow
- Handle AskUserQuestion by pausing and storing in pendingQuestions
- Implement `answerQuestion()` to resume sessions

---

### 🚫 #10: Implement CLI add command
**Status:** pending | **Blocked by:** #3, #19 | **Blocks:** #18

Complete `whs add <name> <path>`:
- Run prerequisite validation (#19)
- Validate path exists and is a git repo
- Prompt for base branch (or use --branch flag)
- Prompt for beads mode (committed/stealth) (or use --stealth flag)
- Initialize beads in the project if not present
- Add project to config
- Create orchestrator beads repo if not exists

---

### 🚫 #11: Implement CLI plan command
**Status:** pending | **Blocked by:** #3

Complete `whs plan <project> <description>`:
- Validate project exists in config
- Create epic in project beads (blocked)
- Create planning task under epic (open)
- Planning task will be picked up by dispatcher and run planner agent

The planner agent definition needs to be created or referenced from NEC.

---

### 🚫 #12: Implement CLI status command
**Status:** pending | **Blocked by:** #5

Complete `whs status`:
- Load state from ~/.whs/state.json
- Show active work (project, bead, agent, duration, cost)
- Show pending questions (with IDs for answering)
- Show paused state
- Optionally show recent completions from metrics DB

---

### 🚫 #13: Implement CLI answer command
**Status:** pending | **Blocked by:** #5, #6

Complete `whs answer <questionId> <answer>`:
- Load pending question from state
- Resume the session with the answer
- Continue the agent loop
- Handle subsequent handoff

May need dispatcher to be running, or handle inline.

---

### 🚫 #14: Add SDK hooks for safety and metrics
**Status:** pending | **Blocked by:** #6

Update agent-runner.ts to include hooks:
- PreToolUse: Block dangerous Bash commands (rm -rf /, force push, etc.)
- PreToolUse: Prevent escaping worktree directory
- SessionEnd: Record cost to metrics DB

Define blocked command patterns as configurable list.

---

### 🚫 #18: End-to-end integration test
**Status:** pending | **Blocked by:** #9, #10, #15

Create a test that runs the full flow:
1. Add a test project
2. Create a simple task in beads
3. Start dispatcher
4. Watch agent pick up task, create PR (or mock)
5. Verify workflow completes
6. Check metrics recorded

This will be a real API test (YOLO), accept the cost.

---

## Dependency Graph

```
#1 ✅ ─┬─► #6 ─┬─► #7 ───► #9 ───► #18
       │       │           ▲
       │       ├─► #13     │
       │       ├─► #14     │
       │       │           │
       └─► #8 ─────────────┤
                           │
#2 ────────────────────────┤
                           │
#3 ───┬─► #10 ─────────────┤
      │    ▲               │
      │    │               │
      │   #19              │
      │                    │
      └─► #11              │
                           │
#5 ───┬─► #9               │
      ├─► #12              │
      └─► #13              │
                           │
#15 ───────────────────────┘

#4, #16, #17, #19 - No dependencies (except #19 blocks #10)
```
