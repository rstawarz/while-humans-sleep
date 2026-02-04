# WHS Agent Definitions

Agent definitions for the While Humans Sleep dispatcher.

## Agents

| Agent | File | Description |
|-------|------|-------------|
| Implementation | `whs-implementation.md` | Senior engineer - implements features and fixes |
| Quality Review | `whs-quality-review.md` | Interprets CI results and routes PRs |
| Release Manager | `whs-release-manager.md` | Merges approved PRs |
| Architect | `whs-architect.md` | Escalation for complex technical problems |
| UX Specialist | `whs-ux-specialist.md` | UI/UX focused implementation |
| Planner | `whs-planner.md` | Plans features and creates implementation tasks |

## Workflow

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

## Handoff Format

All agents output handoffs in YAML format:

```yaml
next_agent: <agent_name>
pr_number: <number if applicable>
ci_status: <pending|passed|failed if applicable>
context: |
  <What you did>
  <What the next agent needs to know>
```

## Valid Agents

- `implementation` - Code implementation
- `quality_review` - CI/review interpretation
- `release_manager` - Merge approved PRs
- `ux_specialist` - UI/UX work
- `architect` - Technical escalation
- `planner` - Feature planning
- `DONE` - Task complete
- `BLOCKED` - Needs human intervention

## Notes for Agents

### Worktrees

Agents run in isolated worktrees. Each task has its own working directory separate from the main repo.

### Beads

Use `bd comment <bead_id> "message"` to add notes to the task bead for future reference.

### Questions

Use `AskUserQuestion` tool when you need clarification. Better to ask than guess.

### Memory via Comments

Record discoveries, decisions, and gotchas using bead comments:

```bash
bd comment <bead_id> "Found X at path/to/file. Using pattern Y."
```

This creates persistent memory for future agents.

## Best Practices

See [Gastown Research](../GASTOWN-RESEARCH.md) for patterns adopted from the Gastown multi-agent orchestration system.
