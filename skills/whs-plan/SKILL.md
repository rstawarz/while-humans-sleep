# WHS Plan

Transform a product proposal into a technical proposal and INVEST stories through a multi-agent review workflow, then consolidate into an importable plan document.

## Usage

```
/whs-plan <proposal_path>
```

**Arguments:**
- `proposal_path` (required): Path to a product proposal file (e.g., `docs/plans/user-auth/product_proposal.md`)

**Inferred from path:**
- **Plan name**: Parent folder name (e.g., `user-auth`)
- **Output location**: Same folder as the proposal

## Conventions

### Input Structure

Place your product proposal in a feature folder:

```
docs/plans/{feature-name}/
└── product_proposal.md
```

### Output Structure

The skill outputs to the same folder:

```
docs/plans/{feature-name}/
├── product_proposal.md       # Your input (unchanged)
├── technical_proposal.md     # The approved technical approach
├── planning_session.md       # Audit trail of the planning process
├── stories/
│   ├── index.md              # Story index with dependency graph
│   ├── 01-{slug}.md          # Story files (e.g., 01-add-login-endpoint.md)
│   ├── 02-{slug}.md
│   └── ...
└── plan-import.md            # Importable plan document for whs import
```

### Story File Naming

Stories are numbered sequentially with a kebab-case slug: `01-add-login-endpoint.md`, `02-create-user-migration.md`, etc. The feature folder provides the namespace — no code prefix needed.

## What It Does

This skill orchestrates a three-phase planning workflow. **You (Claude Code) are the orchestrator.** You execute each phase by spawning Task sub-agents (using the registered agent types below), then evaluate their output and decide what happens next.

### Registered Agents

These are custom Claude Code agents installed in `~/.claude/agents/`. Use them via the Task tool with the exact `subagent_type` names shown:

| subagent_type | Model | Role |
|---------------|-------|------|
| `whs-plan-engineer` | opus | Creates proposals, stories, and import document |
| `whs-plan-architect` | opus | Reviews architecture, arbitrates disagreements |
| `whs-plan-ux-reviewer` | sonnet | Reviews UX aspects |
| `whs-plan-product-manager` | sonnet | Answers product questions (on-demand) |

**IMPORTANT:** Always use these exact subagent_type names. Do NOT use `general-purpose` or any other built-in type for planning roles. Do NOT invent agent type names.

### Phase 1: Technical Proposal (max 5 iterations)

1. Spawn `whs-plan-engineer` to create a technical proposal from the product proposal
2. Spawn `whs-plan-ux-reviewer` to review for user experience considerations
3. Spawn `whs-plan-architect` to review for architectural soundness
4. **You evaluate** the reviews: if both approve, proceed. If not, spawn engineer to revise.
5. **Loop** until both reviewers sign off (or max 5 iterations reached)
6. If reviewers flag `needs_product_clarification`, spawn `whs-plan-product-manager` first

### Phase 2: Story Breakdown (max 3 iterations)

1. Spawn `whs-plan-engineer` to break the approved proposal into INVEST stories
2. Spawn `whs-plan-ux-reviewer` to review UI/design-tagged stories
3. Spawn `whs-plan-architect` to review all stories for sizing and completeness
4. **You evaluate** the reviews: if both approve, proceed. If not, spawn engineer to revise.
5. **Loop** until both reviewers sign off (or max 3 iterations reached)

### Phase 3: Plan Consolidation

1. Spawn `whs-plan-engineer` to consolidate approved stories into `plan-import.md`
2. No review loop — stories are already approved

## Instructions

When this skill is invoked, you ARE the orchestrator. Follow these steps:

### 1. Parse the Proposal Path

Extract from the provided path:
- **Feature name**: Parent folder name
- **Plan directory**: Parent folder path

Example:
```
Input: docs/plans/clerk-to-rodauth-kamal/product_proposal.md

Feature name: clerk-to-rodauth-kamal
Plan directory: docs/plans/clerk-to-rodauth-kamal/
```

### 2. Validate

- Verify the proposal file exists
- Verify it's in a feature folder (not directly in `docs/plans/`)
- Read the proposal content

### 3. Initialize

Create the stories directory and planning session file:

```bash
mkdir -p {plan_directory}/stories
```

Write `{plan_directory}/planning_session.md`:

```markdown
# Planning Session: {feature}

## Status
- **Phase**: 1 - Technical Proposal
- **Iteration**: 0 of 5
- **Sign-offs**: pending

## Review History
[Will be populated as reviews occur]
```

### 4. Phase 1: Technical Proposal

#### 4a. Spawn Engineer — create_proposal

```
Task(subagent_type: "whs-plan-engineer")

MODE: create_proposal

Feature: {feature_name}
Plan Directory: {plan_directory}

Product Proposal:
{proposal content}

Create a technical proposal. Output to: {plan_directory}/technical_proposal.md
Also read the project's CLAUDE.md to understand its tech stack and conventions.
```

#### 4b. Review Loop (max 5 iterations)

For each iteration, spawn UX Reviewer and Architect (can run in parallel):

**UX Reviewer:**
```
Task(subagent_type: "whs-plan-ux-reviewer")

MODE: review_proposal

Feature: {feature_name}
Plan Directory: {plan_directory}
Iteration: {N} of 5

Review the technical proposal at: {plan_directory}/technical_proposal.md
```

**Architect:**
```
Task(subagent_type: "whs-plan-architect")

MODE: review_proposal

Feature: {feature_name}
Plan Directory: {plan_directory}
Iteration: {N} of 5

Review the technical proposal at: {plan_directory}/technical_proposal.md
UX Feedback: {summary from UX review}
```

**You evaluate**: Read the reviews returned by both sub-agents.
- If both say `approved` → proceed to Phase 2
- If either flags `needs_product_clarification` → spawn PM (see 4c), then spawn engineer to revise
- If either says `needs_revision` → spawn engineer to revise with consolidated feedback
- If max iterations (5) reached → document unresolved issues, proceed to Phase 2

**Spawn engineer to revise:**
```
Task(subagent_type: "whs-plan-engineer")

MODE: revise_proposal

Feature: {feature_name}
Plan Directory: {plan_directory}
Iteration: {N} of 5

Feedback to incorporate:

## UX Feedback
{ux feedback}

## Architect Feedback
{architect feedback}

## PM Clarifications (if any)
{pm clarifications}

Revise the technical proposal at: {plan_directory}/technical_proposal.md
```

Update `planning_session.md` after each iteration with review summaries.

#### 4c. Consulting the Product Manager (if needed)

```
Task(subagent_type: "whs-plan-product-manager")

Feature: {feature_name}

Questions:
1. {question from reviewer}
2. {question from reviewer}
```

### 5. Phase 2: Story Breakdown

Update planning_session.md to Phase 2.

#### 5a. Spawn Engineer — create_stories

```
Task(subagent_type: "whs-plan-engineer")

MODE: create_stories

Feature: {feature_name}
Plan Directory: {plan_directory}

The technical proposal has been approved.
Location: {plan_directory}/technical_proposal.md

Break this down into INVEST stories.
Output to: {plan_directory}/stories/
Story file naming: 01-{slug}.md, 02-{slug}.md, etc.
Index file: {plan_directory}/stories/index.md
```

#### 5b. Story Review Loop (max 3 iterations)

Same pattern as Phase 1 review loop, but:
- UX Reviewer uses MODE: `review_stories` (reviews only UI/UX-labeled stories)
- Architect uses MODE: `review_stories` (reviews all stories)
- Engineer uses MODE: `revise_stories` if revisions needed
- Max 3 iterations (approach is already blessed)

### 6. Phase 3: Plan Consolidation

```
Task(subagent_type: "whs-plan-engineer")

MODE: consolidate_plan

Feature: {feature_name}
Plan Directory: {plan_directory}

All stories approved. Consolidate into import document.
Stories: {plan_directory}/stories/
Output: {plan_directory}/plan-import.md
```

No review loop — stories are already approved.

### 7. Update Planning Session

Update `planning_session.md` with final status including iteration counts for each phase.

### 8. Report Completion

Tell the user:
- Location of all outputs (technical proposal, stories, plan-import.md)
- Summary: Phase 1 iterations, Phase 2 iterations, total stories
- Any unresolved issues (if max iterations were hit)
- **Next step**: run `/whs-import-plan {plan_directory}/plan-import.md` to import into beads

## INVEST Criteria

Stories produced by this workflow must satisfy:

| Criterion | Meaning |
|-----------|---------|
| **I**ndependent | Can be built without waiting for other stories |
| **N**egotiable | Describes "what" not "how" |
| **V**aluable | Delivers clear user or business value |
| **E**stimatable | Scope is clear enough to estimate |
| **S**mall | Fits in a sprint (1-5 days typically) |
| **T**estable | Has clear, observable acceptance criteria |

## Handling Failures

- **Max iterations reached**: Architect makes final call on open issues
- **Needs human input**: Pause and report what decision is needed
- **Sub-agent fails**: Retry once, then report the failure to the user

## Tips

- **Start with a clear proposal**: The better the input, the better the output
- **Be available for questions**: PM questions may need your input
- **Review the technical proposal**: Phase 1 sign-off is the key decision point
- **Trust the process**: Let the agents iterate; that's how quality emerges
- **UX and Architect reviews can run in parallel** — spawn both Task agents at the same time
