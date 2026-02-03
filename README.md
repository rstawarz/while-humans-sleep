# While Humans Sleep

> Multi-project AI agent dispatcher using Claude Agent SDK and Beads

An automated system that manages AI agents working across multiple projects. Agents pick up tasks, implement features, create PRs, and hand off to each other — all while you sleep.

## Features

- **Multi-project support** — Manage agents across argyn, bread_and_butter, bridget_ai, or any project
- **Beads integration** — Git-backed task tracking with dependency graphs
- **Workflow orchestration** — Automatic agent handoffs via orchestrator beads
- **Git worktrees** — Parallel work with isolated branches per task
- **Question handling** — Agents can ask questions, you answer via CLI (or Slack later)
- **Planning workflow** — Agents decompose features into tasks before implementation
- **Cost tracking** — Per-step, per-workflow, per-project metrics

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

```
┌─────────────────────────────────────────────────────────────────┐
│                    WHS Dispatcher (Node.js)                     │
├─────────────────────────────────────────────────────────────────┤
│  Project Registry → Work Scheduler → Agent Runner               │
│         │                 │                │                    │
│         ▼                 ▼                ▼                    │
│  Project Beads    Orchestrator Beads   Question Manager         │
│  (per repo)       (workflow state)     → Notifier (CLI/Slack)   │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install -g while-humans-sleep
```

## Usage

```bash
# Add a project
whs add argyn ~/work/argyn

# Start the dispatcher
whs start

# Plan a new feature
whs plan argyn "add user authentication"

# Answer a pending question
whs answer <question-id> "use JWT with refresh tokens"

# Check status
whs status
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Development mode (watch)
npm run dev
```

## License

MIT
