# While Humans Sleep

> Multi-project AI agent dispatcher using Claude Agent SDK and Beads

An automated system that orchestrates AI agents working across multiple projects. Agents pick up tasks from your backlog, implement features, create PRs, review code, and hand off to each other — all while you sleep.

## How It Works

```
You: "whs plan argyn 'add user authentication'"
     ↓
WHS: Creates planning task in argyn's beads
     ↓
Planner Agent: Analyzes codebase, asks clarifying questions,
               creates implementation tasks with dependencies
     ↓
Implementation Agent: Picks up first task, writes code,
                      creates PR, hands off to quality_review
     ↓
Quality Review Agent: Checks CI status, reviews changes,
                      approves or sends back for fixes
     ↓
Release Manager: Merges approved PR
     ↓
You wake up: Feature complete, PR merged ✓
```

## Features

- **Multi-project support** — Manage agents across multiple codebases simultaneously
- **Beads integration** — Git-backed task tracking with dependency graphs
- **Workflow orchestration** — Automatic agent handoffs via orchestrator beads
- **Git worktrees** — Parallel work with isolated branches per task
- **Question handling** — Agents ask questions when stuck, you answer via CLI
- **Planning workflow** — Agents decompose features into tasks before implementation
- **Cost tracking** — Per-step, per-workflow, per-project metrics in SQLite
- **Crash recovery** — State persisted to disk, survives restarts
- **Safety hooks** — Blocks dangerous commands, confines agents to worktrees

## Quick Start

### Prerequisites

- Node.js 20+
- [Beads CLI](https://github.com/steveyegge/beads) installed (`npm install -g @beads/bd`)
- [Worktrunk](https://worktrunk.dev/) for worktree management
- Claude API access (via Claude Agent SDK)

### Installation

```bash
# Clone and install
git clone https://github.com/yourusername/while-humans-sleep
cd while-humans-sleep
npm install
npm run build

# Link for global use
npm link
```

### Setup

```bash
# 1. Add a project
whs add myproject ~/work/myproject

# 2. Initialize beads in your project (if not already)
cd ~/work/myproject
bd init

# 3. Create some tasks
bd create "Add user authentication" -p 1 -t task
bd create "Fix login bug" -p 0 -t bug

# 4. Start the dispatcher
whs start
```

## CLI Commands

### `whs add <name> <path>`

Register a project with the dispatcher.

```bash
whs add myproject ~/work/myproject
whs add myproject ~/work/myproject --base-branch develop
whs add myproject ~/work/myproject --beads-mode stealth
```

Options:
- `--base-branch <branch>` — Base branch for worktrees (default: main)
- `--agents-path <path>` — Path to agent definitions (default: docs/llm/agents)
- `--beads-mode <mode>` — "committed" or "stealth" (default: committed)

### `whs start`

Start the dispatcher. It will continuously poll for work and dispatch agents.

```bash
whs start
```

The dispatcher:
1. Polls project beads for ready tasks (no blocking dependencies)
2. Creates workflow epics in the orchestrator
3. Dispatches agents in isolated worktrees
4. Processes handoffs between agents
5. Handles questions and errors

Press `Ctrl+C` to stop gracefully.

### `whs status`

Show current dispatcher status.

```bash
whs status
whs status --active    # Show only active work
whs status --questions # Show pending questions
```

### `whs plan <project> <description>`

Create a planning workflow for a new feature.

```bash
whs plan myproject "add user authentication with JWT"
whs plan myproject "refactor database layer" --priority 0
```

This creates:
1. A blocked epic in the project's beads
2. A planning task that blocks the epic
3. When the planner completes, implementation tasks are created

### `whs answer <questionId> <answer>`

Answer a pending question from an agent.

```bash
# Check pending questions
whs status --questions

# Answer
whs answer q-1234567890 "use JWT with refresh tokens"
```

## Configuration

Configuration is stored in `~/.whs/config.json`:

```json
{
  "projects": [
    {
      "name": "myproject",
      "repoPath": "/home/user/work/myproject",
      "baseBranch": "main",
      "agentsPath": "docs/llm/agents",
      "beadsMode": "committed"
    }
  ],
  "orchestratorPath": "~/work/whs-orchestrator",
  "concurrency": {
    "maxTotal": 4,
    "maxPerProject": 2
  },
  "notifier": "cli"
}
```

### Concurrency Settings

- `maxTotal` — Maximum concurrent agent runs across all projects
- `maxPerProject` — Maximum concurrent runs per project (prevents git conflicts)

### Orchestrator Path

The dispatcher maintains its own beads repo to track workflow state:

```bash
# Initialize the orchestrator repo
mkdir -p ~/work/whs-orchestrator
cd ~/work/whs-orchestrator
git init
bd init
```

## Agents

WHS includes six specialized agents:

| Agent | Role | Typical Handoffs |
|-------|------|------------------|
| `planner` | Plans features, creates subtasks | → DONE |
| `implementation` | Writes code, creates PRs | → quality_review |
| `quality_review` | Reviews PRs, checks CI | → release_manager or → implementation |
| `release_manager` | Merges approved PRs | → DONE |
| `ux_specialist` | UI/UX focused work | → quality_review |
| `architect` | Technical escalation | → implementation or → BLOCKED |

### Agent Workflow

```
                    ┌─────────────────┐
                    │     planner     │  (planning workflow)
                    └────────┬────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                   Implementation Loop                        │
│                                                              │
│  ┌──────────────┐     ┌─────────────────┐                  │
│  │implementation│────▶│  quality_review │                  │
│  └──────────────┘     └────────┬────────┘                  │
│         ▲                      │                            │
│         │                      ▼                            │
│         │              ┌───────────────┐                   │
│         │              │    Passed?    │                   │
│         │              └───────┬───────┘                   │
│         │         No           │           Yes             │
│         └──────────────────────┤                           │
│                                ▼                            │
│                       ┌────────────────┐                   │
│                       │release_manager │                   │
│                       └───────┬────────┘                   │
│                               │                            │
│                               ▼                            │
│                           [ DONE ]                         │
└─────────────────────────────────────────────────────────────┘

Escalation paths:
  Any agent ──▶ architect ──▶ (back to caller, or BLOCKED)
  Any agent ──▶ ux_specialist ──▶ quality_review
  Any agent ──▶ BLOCKED (needs human)
```

### Handoff Format

Agents output handoffs in YAML format:

```yaml
next_agent: quality_review
pr_number: 42
ci_status: pending
context: |
  Implemented JWT authentication.

  Changes:
  - Added auth middleware
  - Created login/logout endpoints
  - Added tests

  Ready for review.
```

## Beads Integration

### Project Beads

Each project has its own `.beads/` directory tracking tasks:

```bash
# Create tasks
bd create "Add feature X" -p 1 -t task
bd create "Fix bug Y" -p 0 -t bug

# Set dependencies
bd dep add child-id parent-id

# View ready tasks (what the dispatcher sees)
bd ready
```

### Orchestrator Beads

The dispatcher maintains workflow state in a separate repo:

```
bd-w001 (epic: "myproject:bd-123 - Add auth")
├── bd-w001.1 (step: implementation)     ← closed
├── bd-w001.2 (step: quality_review)     ← closed
└── bd-w001.3 (step: release_manager)    ← open (current)
```

### What Agents Can Do with Beads

Agents CAN:
- Add comments: `bd comment bd-123 "Found pattern at src/auth/"`
- Add labels: `bd update bd-123 --label-add needs-migration`

Agents CANNOT:
- Change task status (dispatcher manages lifecycle)
- Create or delete beads
- Modify orchestrator beads

## Worktrees

Each task runs in an isolated git worktree:

```
~/work/myproject/                    # Main checkout
~/work/myproject-worktrees/
├── bd-123/                          # Worktree for task bd-123
├── bd-124/                          # Worktree for task bd-124
└── bd-125/                          # etc.
```

Benefits:
- Agents can't interfere with each other
- Each worktree has its own branch
- Cleaned up when workflow completes

## Metrics

Cost and performance metrics are stored in `~/.whs/metrics.db` (SQLite):

```sql
-- View workflow costs
SELECT id, project, total_cost, status
FROM workflow_runs
ORDER BY started_at DESC;

-- View step costs by agent
SELECT agent, AVG(cost) as avg_cost, COUNT(*) as runs
FROM step_runs
GROUP BY agent;
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Development mode (watch)
npm run dev
```

### Project Structure

```
src/
├── cli.ts             # CLI entry point
├── dispatcher.ts      # Main orchestration loop
├── workflow.ts        # Workflow epic/step management
├── agent-runner.ts    # Claude SDK wrapper
├── handoff.ts         # Handoff parsing (trust-but-verify)
├── config.ts          # Config management (~/.whs/)
├── state.ts           # Crash recovery state
├── metrics.ts         # SQLite metrics database
├── worktree.ts        # Worktrunk wrapper
├── beads/
│   └── client.ts      # Beads CLI wrapper
└── types.ts           # TypeScript interfaces

docs/
├── ARCHITECTURE.md    # Full system design
├── GASTOWN-RESEARCH.md # Multi-agent patterns
└── llm/agents/        # Agent definitions
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — Full system design and rationale
- [Gastown Research](docs/GASTOWN-RESEARCH.md) — Multi-agent patterns we adopted
- [Agent Definitions](docs/llm/agents/README.md) — How each agent works
- [CLAUDE.md](CLAUDE.md) — Guidelines for AI agents working on this project

## Troubleshooting

### "No projects configured"

Add a project first:
```bash
whs add myproject ~/work/myproject
```

### "Orchestrator beads not initialized"

Initialize the orchestrator repo:
```bash
mkdir -p ~/work/whs-orchestrator
cd ~/work/whs-orchestrator
git init
bd init
```

### Agent stuck or producing bad output

Check the workflow step in orchestrator beads:
```bash
cd ~/work/whs-orchestrator
bd show bd-w001.2  # View step details
bd comment bd-w001.2 "Debug notes..."
```

### Rate limit hit

The dispatcher automatically pauses on rate limits. Resume with:
```bash
# Dispatcher logs will show when paused
# It will auto-resume on next tick after the limit clears
```

## License

MIT
