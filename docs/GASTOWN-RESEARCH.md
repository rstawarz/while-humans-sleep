# Gastown Research: Best Practices for WHS

Research findings from [Gastown](https://github.com/steveyegge/gastown) - a multi-agent orchestration system built on Beads.

## Key Concepts

### GUPP - The Propulsion Principle

> "If you find something on your hook, YOU RUN IT."

Agents operate as autonomous pistons in a larger system. Work placed on an agent's hook demands immediate engagement - delays create cascading effects. This principle drives WHS's design: agents execute assignments immediately without awaiting confirmation.

**WHS Application:**
- Our dispatcher picks up ready work from beads and immediately dispatches agents
- Agents don't wait for confirmation - they execute their task and hand off
- The `bd ready` command surfaces unblocked work for immediate execution

### MEOW - Molecular Expression of Work

Breaking large goals into detailed instructions for agents through:
- **Beads**: Atomic work units (our workflow steps)
- **Epics**: Groupings of related beads (our workflow epics)
- **Molecules**: Durable chained workflows that survive agent restarts

**WHS Application:**
- Each source task becomes a workflow epic
- Each agent run is a step bead under the epic
- The orchestrator beads repo maintains this chain

### NDI - Nondeterministic Idempotence

Achieves reliable outcomes despite potentially unreliable processes through:
- Persistent beads tracking work state
- Oversight mechanisms
- Clear recovery paths

**WHS Application:**
- State persistence in `~/.whs/state.json` for crash recovery
- Workflow steps recorded in orchestrator beads
- Resume capability for interrupted sessions

## Agent Role Patterns

### Ephemeral Workers (Polecats)

Gastown's polecats are transient agents that:
1. Spawn for a specific task
2. Work in isolated git worktrees
3. Complete work and self-terminate
4. Hand off to merge queue

**Three-Layer Architecture:**
- **Session Layer**: Claude instance (ephemeral, cycles frequently)
- **Sandbox Layer**: Git worktree (persists until cleanup)
- **Slot Layer**: Identity/name allocation

**WHS Application:**
- Our agents work in isolated worktrees per task
- Session can restart (context compaction) while work persists in worktree
- Agent identity persists through accumulated work history

### Lifecycle States

Gastown has exactly three states (no idle pool):
- **Working**: Actively executing tasks
- **Stalled**: Session stopped mid-work without being nudged back
- **Zombie**: Completed work but failed to exit properly

**WHS Application:**
- Our `active_work` map tracks working state
- `BLOCKED` handoff indicates stalled/needs-human state
- Cleanup on `DONE` prevents zombies

## Work Tracking Patterns

### Convoys

Persistent tracking units for batched work across multiple rigs (projects).

**WHS Application:**
- Our orchestrator beads repo serves this purpose
- Workflow epics track work across projects
- Labels (`project:*`, `source:*`) enable cross-project visibility

### Molecules and Step Closure

> "Mark `in_progress` BEFORE starting, `closed` IMMEDIATELY after completing. Never batch-close steps at the end."

Real-time step closure creates timestamped audit trails.

**WHS Application:**
- Mark step `in_progress` when agent starts
- Close step immediately on handoff
- Create next step atomically with close

### The `--continue` Pattern

Gastown's `bd close <step> --continue` closes current work and advances to next task in one operation, maintaining momentum.

**WHS Application:**
- Our `completeStep` + `createNextStep` should be atomic
- Consider adding `bd close --continue` support if available

## Best Practices for Agent-Bead Interaction

### What Agents CAN Do

1. **Add comments for memory**: `bd comment <id> "note"`
   - Record discoveries, decisions, context for future agents
   - Example: `bd comment bd-a3f8.1 "Found auth module at src/auth/. Using existing UserService pattern."`

2. **Add labels for visibility**: `bd update <id> --label-add <label>`
   - Tag work with metadata (needs-migration, blocked:api, etc.)
   - Example: `bd update bd-a3f8.1 --label-add needs-migration`

3. **Read task details**: `bd show <id>`
   - Get context about what to build
   - Review change history and comments

### What Agents CANNOT Do

1. **Change task status** - Only orchestrator manages lifecycle
2. **Create/delete beads** - Orchestrator owns bead creation
3. **Modify orchestrator beads** - Read-only for agents

### Handoff Protocol

From Gastown's seamless transitions:

```yaml
next_agent: quality_review
pr_number: 42
ci_status: pending
context: |
  Implementation complete.

  What I did:
  - Created auth service at src/auth/
  - Added JWT token handling
  - Tests passing locally

  What the next agent needs to know:
  - PR ready for review
  - Uses existing UserService pattern
  - Config in .env.example
```

## Memory Management Patterns

### Work Context Injection

Gastown injects context into agents at startup rather than having agents read state directly:

**WHS Application:**
- Orchestrator reads workflow step bead
- Injects context into agent prompt
- Agent focuses on execution, not state management

### Capability Records

Each completed task contributes to a capability ledger, enabling:
- Data-driven model evaluation
- Demonstrable competence tracking
- Attribution for work

**WHS Application:**
- Metrics database tracks per-agent-type performance
- Cost tracking per step enables efficiency analysis
- Outcome tracking (success/failure/blocked) builds capability data

## Patterns to Adopt for WHS

### 1. Immediate Execution (GUPP)

```typescript
// Don't wait - execute immediately when work is ready
const readySteps = getReadyWorkflowSteps();
for (const step of readySteps) {
  this.dispatchAgent(step);  // Fire and forget
}
```

### 2. Real-Time State Updates

```typescript
// Mark in_progress BEFORE starting
markStepInProgress(stepId);

// Run agent
const result = await runAgent(step);

// Close IMMEDIATELY after
completeStep(stepId, result.outcome);
createNextStep(epicId, result.nextAgent, result.context);
```

### 3. Agent Memory via Comments

Include in agent prompts:
```markdown
## Recording Decisions

Use `bd comment <bead_id> "message"` to record:
- Discoveries about the codebase
- Decisions and rationale
- Gotchas for future agents
- Links to relevant files or PRs
```

### 4. Clear Handoff Context

Handoffs should answer:
- What did you do?
- What should the next agent know?
- What's the PR/CI status?
- Are there any gotchas?

### 5. Three-Layer Thinking

Design with session/sandbox/identity separation:
- **Session**: Can restart (context compaction, crashes)
- **Sandbox**: Persists work (worktree, uncommitted changes)
- **Identity**: Persists attribution (metrics, capability records)

## Comparison: Gastown vs WHS

| Aspect | Gastown | WHS |
|--------|---------|-----|
| Agent Types | Mayor, Polecat, Crew, etc. | implementation, quality_review, etc. |
| Work Units | Molecules, Beads | Workflow Epics, Steps |
| Orchestration | Mayor + gt commands | Dispatcher + SDK |
| State Storage | Hooks, git worktrees | Orchestrator beads, state.json |
| Concurrency | 20-30 agents | 4 agents (configurable) |
| Scope | Multi-rig (project) | Multi-project |

## Future Considerations

### From Gastown's Advanced Features

1. **Formulas**: TOML-defined reusable workflows
   - Could add formula support for common patterns

2. **Witness Role**: Health monitoring agent
   - Could add dispatcher health checks

3. **Merge Queue (Refinery)**: Automated conflict resolution
   - Currently handled by release_manager agent

4. **CV Chains**: Agent capability tracking
   - Metrics DB provides foundation for this

### Research Notes

- Gastown scales to 20-30 concurrent agents
- Our MAX_CONCURRENT_TOTAL=4 is conservative but safe starting point
- Consider increasing as stability is proven

## References

- [Gastown Repository](https://github.com/steveyegge/gastown)
- [Beads Repository](https://github.com/steveyegge/beads)
- [WHS Architecture](./ARCHITECTURE.md)
