# CLAUDE.md - While Humans Sleep

Guidelines for Claude Code and AI agents working on this project.

## Project Overview

While Humans Sleep (WHS) is a multi-project AI agent dispatcher using the Claude Agent SDK and Beads for task management. It orchestrates agents across multiple codebases, managing worktrees, handoffs, and workflow state.

**Read the full architecture document:** @docs/ARCHITECTURE.md

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 20+
- **Package Manager:** npm
- **Build:** tsc (ES2022, NodeNext modules)
- **Test Framework:** vitest
- **CLI Framework:** commander

## Code Style & Conventions

### TypeScript

- Always use TypeScript, never plain JavaScript
- Enable strict mode — no `any` types unless absolutely necessary
- Use explicit return types on functions
- Prefer `interface` over `type` for object shapes
- Use `readonly` for properties that shouldn't change
- Prefer `unknown` over `any` when type is truly unknown

```typescript
// Good
function processWork(item: WorkItem): Promise<Handoff> { ... }

// Bad
function processWork(item: any): any { ... }
```

### Imports & Modules

- Use ES modules (`import`/`export`), not CommonJS
- Include `.js` extension in relative imports (required for NodeNext)
- Group imports: external packages, then internal modules, then types

```typescript
// Good
import { execSync } from "child_process";
import { BeadsClient } from "./beads/client.js";
import type { WorkItem, Handoff } from "./types.js";
```

### Naming Conventions

- **Files:** kebab-case (`beads-client.ts`, `agent-runner.ts`)
- **Classes:** PascalCase (`Dispatcher`, `CLINotifier`)
- **Functions/variables:** camelCase (`runAgent`, `workItem`)
- **Constants:** SCREAMING_SNAKE_CASE (`MAX_RETRIES`, `DEFAULT_TIMEOUT`)
- **Types/Interfaces:** PascalCase (`WorkItem`, `Handoff`)

### Error Handling

- Use typed errors when possible
- Always include context in error messages
- Don't swallow errors silently — log or rethrow

```typescript
// Good
throw new Error(`Failed to parse handoff from agent output: ${output.slice(0, 100)}`);

// Bad
throw new Error("Parse error");
```

### Async/Await

- Prefer `async`/`await` over raw Promises
- Use `Promise.all` for parallel operations
- Always handle rejections

### External Commands

- Use `execSync` for simple commands that must complete
- Use `spawn` for streaming output
- Always specify `{ encoding: "utf-8" }` for text output
- Always specify `{ cwd }` to ensure correct working directory

```typescript
const result = execSync("bd ready --json", {
  cwd: projectPath,
  encoding: "utf-8",
});
```

## Project Structure

```
src/
├── index.ts           # Public exports
├── cli.ts             # CLI entry point
├── dispatcher.ts      # Main orchestration loop
├── types.ts           # All TypeScript interfaces
├── config.ts          # Config management (~/.whs/)
├── state.ts           # State persistence for crash recovery
├── metrics.ts         # SQLite metrics database
├── worktree.ts        # Worktrunk wrapper
├── workflow.ts        # Workflow orchestration (orchestrator beads)
├── handoff.ts         # Handoff parsing and tool
├── agent-runner.ts    # Claude SDK wrapper
├── beads/
│   └── client.ts      # Beads CLI wrapper
└── notifiers/
    ├── cli.ts         # Console notifications
    └── slack.ts       # Slack notifications (future)
```

## Testing

- Write tests for all non-trivial functions
- Use vitest for testing
- Mock external dependencies (bd CLI, git, Claude SDK)
- Test files live next to source: `foo.ts` → `foo.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { tryParseHandoff } from "./handoff.js";

describe("tryParseHandoff", () => {
  it("parses YAML block from output", () => {
    const output = "Done.\n```yaml\nnext_agent: quality_review\n```";
    const handoff = tryParseHandoff(output);
    expect(handoff?.next_agent).toBe("quality_review");
  });
});
```

## Commands

```bash
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm test           # Run tests
npm run lint       # Lint code
```

## Architecture Principles

1. **Orchestrator owns state** — Agents don't manage beads lifecycle, they just do work and produce handoffs
2. **Trust but verify** — Expect agents to output handoffs correctly, but verify and fallback to tool if needed
3. **Crash recovery** — Persist state to disk after every significant change
4. **Isolated worktrees** — Each task gets its own worktree, agents can't interfere with each other
5. **Two beads, two purposes** — Project beads track what to build, orchestrator beads track how it's being built

## Beads Interaction

Agents CAN:
- Add comments to project beads (`bd comment`)
- Add labels to project beads (`bd update --label-add`)

Agents CANNOT:
- Change bead status (open/closed/in_progress)
- Create or delete beads
- Modify orchestrator beads

The dispatcher handles all bead lifecycle operations.

## Handoff Format

Agents should output handoffs in their response:

```yaml
next_agent: quality_review
pr_number: 47
ci_status: pending
context: |
  Implemented auth service with JWT tokens.
  Tests passing locally, ready for CI.
```

If parsing fails, the dispatcher will resume the session and request handoff via tool call.

## Dependencies

Key packages:
- `commander` — CLI framework
- `better-sqlite3` — Metrics database
- `@anthropic-ai/claude-agent-sdk` — Agent execution (when available)
- `yaml` — YAML parsing for handoffs

## Links

- [Architecture Doc](docs/ARCHITECTURE.md)
- [Beads](https://github.com/steveyegge/beads)
- [Worktrunk](https://worktrunk.dev/)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
