# Agentic Dispatcher Architecture

> Plan for migrating NEC from bash/Ruby CLI orchestration to a TypeScript-based dispatcher using the Claude Agent SDK, with Beads for task and workflow state management.

## Overview

Replace the current architecture:
```
Ruby loop → parse YAML → shell out to `claude --agent` → new process each time → read YAML back
```

With:
```
TypeScript dispatcher → Claude Agent SDK query() → in-process agent execution → Beads state management
```

## Key Components

### 1. Claude Agent SDK Integration

Instead of shelling out to `claude --agent`, call the SDK directly:

```typescript
import { query, ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query(prompt, {
  agentDefinition: agentFile,
  cwd: worktreePath,                    // Agent works in specific directory
  settingSources: ["project"],           // Load project's CLAUDE.md
  dangerouslyBypassPermissions: true,
  maxTurns: 50,
})) {
  // Stream output, track costs, handle questions
}
```

**Benefits over shell-out:**
- No process spawn overhead
- Typed message objects (no JSON parsing from stdout)
- Session resumption via `resume: sessionId`
- In-process hooks instead of shell scripts
- Direct access to cost tracking

**Important:** Must set `settingSources: ["project"]` to load each project's CLAUDE.md and .claude/settings.json.

### 2. Beads for Task Management

Each project uses Beads (https://github.com/steveyegge/beads) for its task backlog:

```
~/work/argyn/.beads/              # argyn's tasks
~/work/bread_and_butter/.beads/   # bread_and_butter's tasks
~/work/bridget_ai/.beads/         # bridget_ai's tasks
```

Beads provides:
- Git-backed task storage (travels with repo, works with worktrees)
- Dependency graph (`bd dep add child parent`)
- Priority levels (0-4, where 0 is critical)
- `bd ready --json` returns unblocked tasks sorted by priority
- Automatic "memory decay" compaction for old closed tasks

**Status values:** open, in_progress, blocked, deferred, closed, tombstone, pinned

**Replaces:** GitHub Projects/Issues for task tracking

### 3. Orchestrator Beads for Workflow State

Separate from project beads, the orchestrator maintains its own beads repo to track workflow execution state:

```
~/work/nec-orchestrator/.beads/   # workflow execution state
```

**Structure:**
- Each source task (e.g., `argyn:bd-a3f8.1`) gets a **workflow epic** in the orchestrator
- Each agent run is a **task** under that epic
- The dependency graph encodes execution order
- `bd ready` on orchestrator returns the next agent steps to run

```
Orchestrator beads:

bd-w001 (epic: "argyn:bd-a3f8.1 - Implement auth service")     status: open
├── bd-w001.1 (task: "implementation")                         status: closed
├── bd-w001.2 (task: "quality_review")                         status: closed
├── bd-w001.3 (task: "implementation - CI fix")                status: closed
├── bd-w001.4 (task: "quality_review - recheck")               status: closed
└── bd-w001.5 (task: "release_manager")                        status: open ← current
```

**Why two beads?**

| Project beads | Orchestrator beads |
|--------------|-------------------|
| What to build | How it's being built |
| Feature backlog | Execution state |
| User-facing tasks | Agent workflow steps |
| Closed when feature ships | Closed when step completes |

### 4. Multi-Project Support

The dispatcher manages multiple projects concurrently:

```typescript
const PROJECTS = {
  argyn: { repoPath: "~/work/argyn", baseBranch: "main" },
  bread_and_butter: { repoPath: "~/work/bread_and_butter", baseBranch: "main" },
  bridget_ai: { repoPath: "~/work/bridget_ai", baseBranch: "main" },
};
```

**Concurrency limits:**
- `MAX_CONCURRENT_TOTAL = 4` — total parallel agent runs
- `MAX_CONCURRENT_PER_PROJECT = 2` — prevents git conflicts within a project

### 5. Git Worktrees for Isolation

Each work item gets its own worktree:

```
~/work/argyn/                      # main checkout
~/work/argyn-worktrees/
├── bd-a3f8.1/                     # worktree for this task
├── bd-a3f8.2/                     # worktree for another task
└── bd-b2c4/                       # etc.
```

**Benefits:**
- Agents can't interfere with each other
- Each worktree sees the same `.beads/` data (shared .git)
- Branch per task, auto-named from bead ID
- Cleaned up when workflow completes

### 6. Question Handling (AskUserQuestion)

When an agent calls `AskUserQuestion`, the dispatcher:

1. Pauses that work item (saves session ID for resumption)
2. Stores the question in `pendingQuestions` map
3. Notifies the user via the Notifier interface
4. Waits for answer
5. Resumes the session with the answer

**Notifier interface (for future Slack support):**

```typescript
interface Notifier {
  notifyQuestion(question: PendingQuestion): Promise<void>;
  notifyProgress(work: ActiveWork, message: string): Promise<void>;
  notifyComplete(work: ActiveWork, result: "done" | "blocked"): Promise<void>;
  notifyError(work: ActiveWork, error: Error): Promise<void>;
}
```

**MVP:** CLI notifier prints to console, user answers via `nec answer <id> "response"`

**Future:** Slack notifier posts to channel, user replies in thread, webhook captures response

### 7. Planning Workflow

For new features, a planning phase precedes implementation:

```
User: nec plan argyn "add user authentication"
```

**Flow:**

1. Create epic in project beads (blocked)
2. Create planning task under epic (open)
3. Planning task shows up in `bd ready`
4. Dispatcher runs **planner agent**
5. Planner analyzes, asks clarifying questions via AskUserQuestion
6. User answers questions
7. Planner creates subtasks with dependencies
8. Planner presents plan summary, asks for approval
9. User approves
10. Planner closes planning task → epic unblocks
11. Implementation tasks now appear in `bd ready`

**Beads structure for planning:**

```
Project beads (argyn):

bd-a3f8 (epic: "Add user authentication")        status: blocked
├── bd-a3f8.plan (task: "Plan: authentication")  status: open    ← blocks epic
├── bd-a3f8.1 (task: "Implement auth service")   status: blocked ← blocked by .plan
├── bd-a3f8.2 (task: "Add auth tests")           status: blocked ← blocked by .1
└── bd-a3f8.3 (task: "Auth documentation")       status: blocked ← blocked by .2
```

When `bd-a3f8.plan` closes, the downstream tasks unblock in dependency order.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NEC Dispatcher (Node.js)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │ Project      │     │ Work         │     │ Agent        │                │
│  │ Registry     │────▶│ Scheduler    │────▶│ Runner       │                │
│  │              │     │              │     │              │                │
│  │ - argyn      │     │ - poll beads │     │ - SDK query  │                │
│  │ - b_and_b    │     │ - prioritize │     │ - worktrees  │                │
│  │ - bridget    │     │ - dispatch   │     │ - streaming  │                │
│  └──────────────┘     └──────────────┘     └──────────────┘                │
│         │                    │                    │                         │
│         │                    │                    │                         │
│         ▼                    ▼                    ▼                         │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │ Project      │     │ Orchestrator │     │ Question     │                │
│  │ Beads        │     │ Beads        │     │ Manager      │                │
│  │ (per repo)   │     │ (workflow)   │     │              │                │
│  └──────────────┘     └──────────────┘     └──────────────┘                │
│                                                   │                         │
│                                                   ▼                         │
│                                            ┌──────────────┐                │
│                                            │ Notifier     │                │
│                                            │ - CLI (MVP)  │                │
│                                            │ - Slack      │                │
│                                            └──────────────┘                │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Dispatcher Main Loop

```typescript
async function tick(): Promise<void> {
  // 1. Process any answered questions (resume paused sessions)
  await this.processAnsweredQuestions();

  // 2. Poll orchestrator beads for ready workflow steps
  const workflowSteps = await this.getReadyWorkflowSteps();
  for (const step of workflowSteps) {
    if (this.isAtCapacity()) break;
    if (this.isAlreadyRunning(step.id)) continue;
    this.dispatchAgent(step);  // async, runs in background
  }

  // 3. If under capacity, poll project beads for new work
  if (this.activeWork.size < MAX_CONCURRENT_TOTAL) {
    const newWork = await this.pollProjectBacklogs();
    const next = this.pickHighestPriority(newWork);
    if (next) {
      await this.startWorkflow(next);  // create workflow epic, dispatch first agent
    }
  }
}
```

## Agent Handoff Flow

```typescript
async function onAgentComplete(
  workflowEpicId: string,
  currentStepBead: string,
  outcome: string,
  nextAgent: string,
  context: string
): Promise<void> {
  // Close current step
  execSync(`bd close ${currentStepBead} --reason "${outcome}"`, { cwd: orchestratorPath });

  if (nextAgent === "DONE") {
    // Close workflow epic
    execSync(`bd close ${workflowEpicId} --reason "Complete"`, { cwd: orchestratorPath });
    // Close source bead in project
    await this.closeSourceBead(workflowEpicId);
    // Clean up worktree
    await this.removeWorktree(workflowEpicId);
    return;
  }

  if (nextAgent === "BLOCKED") {
    execSync(`bd update ${workflowEpicId} --label-add blocked:human`, { cwd: orchestratorPath });
    await this.notifier.notifyBlocked(workflowEpicId);
    return;
  }

  // Create next step under same epic
  execSync(
    `bd create "${nextAgent}" -t task --parent ${workflowEpicId} --label agent:${nextAgent} --description "${context}"`,
    { cwd: orchestratorPath }
  );
}
```

## Workflow State Machine

```
┌─────────────────────────────────────────────────────────────────┐
│                    Workflow State Machine                       │
│                    (encoded as beads under workflow epic)       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌──────────┐                                                  │
│   │  START   │  (workflow epic created)                         │
│   └────┬─────┘                                                  │
│        │                                                        │
│        ▼                                                        │
│   ┌──────────────┐     needs_ux     ┌──────────────┐           │
│   │implementation│─────────────────▶│ux_specialist │           │
│   │              │◀─────────────────│              │           │
│   └──────┬───────┘     done         └──────────────┘           │
│          │                                  │                   │
│          │ pr_created                       │ pr_created        │
│          ▼                                  ▼                   │
│   ┌──────────────┐◀─────────────────────────┘                  │
│   │quality_review│                                              │
│   └──────┬───────┘                                              │
│          │                                                      │
│          ├─── ci_failed ──────▶ implementation (fix)           │
│          ├─── changes_requested ──▶ implementation/ux          │
│          ├─── needs_arch ─────▶ architect                      │
│          │                                                      │
│          │ approved                                             │
│          ▼                                                      │
│   ┌──────────────┐                                              │
│   │release_manager│                                             │
│   └──────┬───────┘                                              │
│          │                                                      │
│          ├─── merge_conflict ──▶ implementation                │
│          │                                                      │
│          │ merged                                               │
│          ▼                                                      │
│   ┌──────────────┐                                              │
│   │    DONE      │  → close workflow epic, close source bead   │
│   └──────────────┘    clean up worktree                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## CLI Interface

```bash
# Start the dispatcher (runs continuously)
nec start

# Plan a new feature (creates planning workflow)
nec plan argyn "add user authentication"

# Answer a pending question
nec answer <question-id> "use JWT with refresh tokens"

# Show status
nec status

# Show active work across all projects
nec status --active

# Show pending questions
nec status --questions

# Stop a specific workflow
nec stop argyn/bd-a3f8.1

# Stop all work gracefully
nec stop --all
```

## Directory Structure

```
nec-dispatcher/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── dispatcher.ts         # Main dispatcher class
│   ├── scheduler.ts          # Work scheduling logic
│   ├── agent-runner.ts       # SDK query wrapper
│   ├── workflow.ts           # Workflow epic/step management
│   ├── planning.ts           # Planning workflow logic
│   ├── worktree.ts           # Git worktree management
│   ├── beads.ts              # Beads CLI wrapper
│   ├── state.ts              # Crash recovery state
│   ├── types.ts              # TypeScript interfaces
│   ├── config.ts             # Configuration loading
│   └── notifiers/
│       ├── interface.ts
│       ├── cli.ts            # MVP: console output
│       └── slack.ts          # Future: Slack integration
├── package.json
├── tsconfig.json
└── config.json
```

## Configuration

```json
{
  "projects": [
    {
      "name": "argyn",
      "repoPath": "~/work/argyn",
      "baseBranch": "main",
      "agentsPath": "docs/llm/agents"
    },
    {
      "name": "bread_and_butter",
      "repoPath": "~/work/bread_and_butter",
      "baseBranch": "main",
      "agentsPath": "docs/llm/agents"
    },
    {
      "name": "bridget_ai",
      "repoPath": "~/work/bridget_ai",
      "baseBranch": "main",
      "agentsPath": "docs/llm/agents"
    }
  ],
  "orchestratorPath": "~/work/nec-orchestrator",
  "concurrency": {
    "maxTotal": 4,
    "maxPerProject": 2
  },
  "notifier": "cli",
  "slack": {
    "token": "${SLACK_BOT_TOKEN}",
    "channelId": "C01234567"
  }
}
```

## Migration Path

### Phase 1: Core Dispatcher (MVP)
- [ ] Set up TypeScript project with Agent SDK
- [ ] Implement single-project agent dispatch via SDK
- [ ] Implement worktree creation/cleanup
- [ ] Implement basic handoff parsing (keep shared notes file for now)
- [ ] CLI notifier for questions
- [ ] Test with one project (argyn)

### Phase 2: Beads Integration
- [ ] Install beads in test project
- [ ] Replace GitHub Issues polling with `bd ready`
- [ ] Create orchestrator beads repo
- [ ] Implement workflow epic/step pattern
- [ ] Remove shared notes file dependency for handoffs

### Phase 3: Multi-Project
- [ ] Add project registry
- [ ] Implement per-project concurrency limits
- [ ] Test with all three projects
- [ ] Add cross-project status view

### Phase 4: Planning Workflow
- [ ] Implement planner agent
- [ ] Planning task → subtask creation flow
- [ ] User approval workflow
- [ ] Integrate with AskUserQuestion

### Phase 5: Slack Integration
- [ ] Slack notifier implementation
- [ ] Webhook receiver for thread replies
- [ ] Question → answer mapping
- [ ] Session resumption from Slack answers

## Comparison: Current vs New

| Aspect | Current (Ruby/CLI) | New (TS/SDK) |
|--------|-------------------|--------------|
| Agent invocation | Shell out to `claude` | SDK `query()` call |
| State management | YAML in shared notes file | Orchestrator beads |
| Task tracking | GitHub Projects/Issues | Project beads |
| Concurrency | Sequential only | Parallel (configurable) |
| Question handling | Not supported | AskUserQuestion → Notifier |
| Crash recovery | Shared notes file persists | Beads + state.json |
| Multi-project | Single project | Native multi-project |
| Planning | Manual issue creation | Agent-driven planning workflow |
| Context per agent | Full (fresh session) | Full (fresh session per step) |

## Resolved Questions

### 1. Agent definitions: Markdown files or programmatic?

**Decision:** Keep markdown files, use `agentDefinition` with file path.

```typescript
for await (const message of query(prompt, {
  agentDefinition: "docs/llm/agents/nec-senior-engineer.md",
})) { ... }
```

This matches current `claude --agent` behavior and keeps agents editable/version-controlled.

### 2. Shared notes file: Remove or keep?

**Decision:** Remove the shared notes file. Working memory moves to orchestrator bead descriptions.

- Orchestrator reads workflow step bead for context
- Orchestrator injects context into agent prompt
- Agent produces structured handoff output
- Orchestrator parses output and creates next step with updated context

Agents never read orchestrator beads directly — context is injected by the dispatcher.

### 3. Who manages beads?

**Decision:** Orchestrator owns lifecycle, agents can annotate.

**Orchestrator responsibilities:**
- All orchestrator beads (workflow epics and steps)
- Project bead lifecycle: `open` → `in_progress` → `closed`
- Reading context from beads, injecting into agent prompts
- Parsing agent output, creating next workflow steps

**Agent responsibilities:**
- Work in project directory (worktree)
- Read/write project files, create PRs, run tests
- Can add notes/comments to project beads for memory
- Can add labels to project beads for visibility
- Produce structured handoff output

Agents do NOT change task status (open/closed/in_progress).

Example agent bead interaction (note-taking only):
```bash
# Add a note about what you discovered
bd comment bd-a3f8.1 "Found auth module at src/auth/. Using existing UserService pattern."

# Add a label for visibility
bd update bd-a3f8.1 --label-add needs-migration
```

### 4. Beads stealth mode

**Decision:** Per-project choice made at onboarding time.

When running `nec add <project>`, prompt:
```
Beads mode:
  1. Committed - .beads/ tracked in git (recommended for solo projects)
  2. Stealth - .beads/ local only (for shared repos)
```

Store in project config as `beadsMode: "committed" | "stealth"`.

### 5. Cost tracking

**Decision:** Track at all levels, store in SQLite.

Location: `~/.nec/metrics.db`

```sql
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,           -- bd-w001
  project TEXT,
  source_bead TEXT,              -- argyn:bd-a3f8.1
  started_at DATETIME,
  completed_at DATETIME,
  status TEXT,                   -- done, blocked
  total_cost REAL
);

CREATE TABLE step_runs (
  id TEXT PRIMARY KEY,           -- bd-w001.2
  workflow_id TEXT,
  agent TEXT,
  started_at DATETIME,
  completed_at DATETIME,
  cost REAL,
  outcome TEXT
);
```

Aggregation queries give per-step, per-workflow, per-project, and per-agent-type views.

### 6. Hooks

**Decision:** Minimal hooks, trust-but-verify handoff pattern.

**SDK Hooks used:**

| Hook | Purpose |
|------|---------|
| `PreToolUse` | Block dangerous commands (rm -rf, force push, escaping worktree) |
| `SessionEnd` | Record cost to metrics DB |

```typescript
hooks: {
  PreToolUse: [{
    matcher: /Bash/,
    hooks: [async ({ toolInput }) => {
      const cmd = toolInput.command;
      if (cmd.includes("rm -rf /") || cmd.includes("--force push")) {
        return { decision: "deny", message: "Blocked dangerous command" };
      }
      return {};
    }]
  }],
  SessionEnd: [{
    hooks: [async ({ sessionId, cost }) => {
      await metricsDb.recordCost(sessionId, cost);
    }]
  }]
}
```

**Handoff capture: Trust but verify**

Instead of relying solely on hooks, use a trust-but-verify pattern:

1. Agent prompt includes handoff format instructions (same as current NEC)
2. After agent completes, try to parse handoff from output
3. If parsing fails, resume session and force handoff via tool

```typescript
// 1. Run agent (prompt includes handoff instructions)
for await (const message of query(taskPrompt, options)) {
  // collect output, capture sessionId
}

// 2. Try to parse handoff from output
let handoff = tryParseHandoff(agentOutput);

// 3. If missing/malformed, resume and force via tool
if (!handoff) {
  logger.log("Handoff not found, requesting via tool...");

  for await (const message of query(
    "Your handoff was missing or malformed. Call the Handoff tool now.",
    {
      resume: sessionId,
      maxTurns: 1,
      allowedTools: ["Handoff"],
      customTools: [handoffTool]
    }
  )) {
    const toolCall = findToolCall(message, "Handoff");
    if (toolCall) handoff = toolCall.input;
  }
}

// 4. Fallback if still nothing
if (!handoff) {
  handoff = { next_agent: "BLOCKED", context: "Agent failed to produce handoff" };
}
```

**Benefits:**
- 99% of runs: agent outputs handoff correctly, no extra cost
- 1% of runs: resume + tool call, ~$0.001 extra
- Replaces `notes_repair` agent entirely
- Guaranteed structured output in all cases

The `Handoff` tool schema:
```typescript
const handoffTool = {
  name: "Handoff",
  description: "REQUIRED: Call this to complete your work and hand off to the next agent",
  parameters: {
    next_agent: {
      type: "string",
      enum: ["implementation", "quality_review", "release_manager", "ux_specialist", "architect", "DONE", "BLOCKED"]
    },
    pr_number: { type: "number", optional: true },
    ci_status: { type: "string", enum: ["pending", "passed", "failed"], optional: true },
    context: { type: "string", description: "What you did and what the next agent needs to know" }
  }
};
```

### 7. Rate limiting

**Decision:** Detect and pause, don't try to be smart about it.

When a rate limit error is detected:
1. Pause the dispatcher (stop picking up new work)
2. Requeue the current work item
3. Notify user via CLI/Slack
4. User runs `nec resume` when ready

```typescript
async function dispatchAgent(work: WorkItem): Promise<void> {
  try {
    await runAgentLoop(work);
  } catch (err) {
    if (isRateLimitError(err)) {
      logger.log("Rate limit hit. Pausing dispatcher.");
      await notifier.notifyRateLimit(err);
      this.pause();
      this.requeueWork(work);
      return;
    }
    throw err;
  }
}

function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("too many requests")
  );
}
```

Can add smarter backoff/retry later if needed.

### 8. Testing

**Decision:** Mocks for unit tests, real API for integration/YOLO.

- **Unit tests:** Mock the SDK's `query()` function to return canned message sequences
- **Integration tests:** Real API calls, accept the cost
- **Iterative improvement:** When we hit bugs in production, update mocks to cover the scenario

```typescript
// Mock for unit tests
const mockQuery = jest.fn().mockImplementation(async function* () {
  yield { type: "system", subtype: "init", session_id: "test-session" };
  yield { type: "assistant", message: { content: [{ type: "text", text: "Done" }] } };
  yield { type: "result", cost_usd: 0.01 };
});

// Test
it("parses handoff from agent output", async () => {
  mockQuery.mockImplementation(async function* () {
    yield { type: "assistant", message: { content: [{
      type: "text",
      text: "```yaml\nnext_agent: quality_review\ncontext: PR created\n```"
    }]}};
    yield { type: "result", cost_usd: 0.01 };
  });

  const handoff = await runAgentAndGetHandoff(mockQuery, work);
  expect(handoff.next_agent).toBe("quality_review");
});
```

No open questions remain. Time to build.

## Research Tasks

### Gastown — Agent Coaching for Beads

Investigate [Gastown](https://github.com/steveyegge/gastown) — the teaching/coaching layer for beads.

**Goals:**
- Understand how Gastown teaches agents to use beads effectively
- Learn best practices for agent-bead interaction patterns
- Identify coaching approaches we should adopt for our own agents
- Document useful patterns for agent note-taking and memory
