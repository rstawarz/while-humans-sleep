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
│   ├── {CODE}-01-{slug}.md   # Story files (e.g., AUTH-01-add-login-endpoint.md)
│   ├── {CODE}-02-{slug}.md
│   └── ...
└── plan-import.md            # Importable plan document for whs import
```

### Story ID Convention

Stories are numbered sequentially with a code derived from the feature name:

| Feature Name | Code | Example Story ID |
|--------------|------|------------------|
| `user-auth` | `AUTH` | `AUTH-01`, `AUTH-02` |
| `clerk-to-rodauth-kamal` | `CLERK` | `CLERK-01`, `CLERK-02` |
| `dashboard-export` | `DASH` | `DASH-01`, `DASH-02` |

The code is generated from the first word of the feature name, uppercased, max 5 characters.

## What It Does

This skill orchestrates a three-phase planning workflow:

### Phase 1: Technical Proposal (max 5 iterations)

1. **Engineer** creates a technical proposal from the product proposal
2. **UX Reviewer** reviews for user experience considerations
3. **Architect** reviews for architectural soundness
4. **Loop** until both reviewers sign off (or max iterations reached)
5. **Product Manager** consulted if business questions arise

### Phase 2: Story Breakdown (max 3 iterations)

1. **Engineer** breaks the approved proposal into INVEST stories
2. **UX Reviewer** reviews UI/design-tagged stories
3. **Architect** reviews all stories for sizing and completeness
4. **Loop** until both reviewers sign off (or max iterations reached)

### Phase 3: Plan Consolidation

1. **Engineer** reads all approved stories
2. Consolidates into `plan-import.md` in exact `whs import` format
3. No review loop — stories are already approved

## Agents Involved

| Agent | Model | Role |
|-------|-------|------|
| `whs-plan-orchestrator` | opus | Coordinates the workflow |
| `whs-plan-engineer` | opus | Creates proposal, stories, and import document |
| `whs-plan-architect` | opus | Reviews architecture, arbitrates disagreements |
| `whs-plan-ux-reviewer` | sonnet | Reviews UX aspects |
| `whs-plan-product-manager` | sonnet | Answers product questions (on-demand) |

## Instructions

When this skill is invoked:

### 1. Parse the Proposal Path

Extract from the provided path:
- **Feature name**: Parent folder name
- **Plan directory**: Parent folder path
- **Story code**: First word of feature name, uppercased, max 5 chars

Example:
```
Input: docs/plans/clerk-to-rodauth-kamal/product_proposal.md

Feature name: clerk-to-rodauth-kamal
Plan directory: docs/plans/clerk-to-rodauth-kamal/
Story code: CLERK
```

### 2. Validate

- Verify the proposal file exists
- Verify it's in a feature folder (not directly in `docs/plans/`)
- Read the proposal content

### 3. Initialize

Create the stories directory:

```bash
mkdir -p {plan_directory}/stories
```

### 4. Start the Orchestrator

Invoke the `whs-plan-orchestrator` agent with:

```yaml
next_agent: whs-plan-orchestrator
next_action: start
context: |
  Feature: {feature_name}
  Story Code: {story_code}
  Plan Directory: {plan_directory}

  Product Proposal:
  {proposal content}

  Output files to:
  - Technical proposal: {plan_directory}/technical_proposal.md
  - Planning session: {plan_directory}/planning_session.md
  - Stories: {plan_directory}/stories/
  - Import document: {plan_directory}/plan-import.md

  Begin the planning workflow.
blockers: none
```

### 5. Follow the Workflow

The orchestrator will coordinate the agents through:
- Phase 1: Technical proposal creation and review
- Phase 2: Story breakdown and review
- Phase 3: Plan consolidation into import format

Each agent hands off to the next via the orchestrator.

### 6. Report Completion

When the orchestrator returns `DONE`, report to the user:
- Location of outputs
- Summary of iterations
- Number of stories created
- Any unresolved issues (if max iterations were hit)
- Path to `plan-import.md` and instructions to run `/whs-import-plan {plan_directory}/plan-import.md`

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

If the workflow gets stuck:
- **Max iterations reached**: Architect makes final call on open issues
- **Needs human input**: Workflow pauses and reports what decision is needed
- **Blocked**: Check `planning_session.md` for details on the blocker

## Tips

- **Start with a clear proposal**: The better the input, the better the output
- **Be available for questions**: PM questions may need your input
- **Review the technical proposal**: Phase 1 sign-off is the key decision point
- **Trust the process**: Let the agents iterate; that's how quality emerges
