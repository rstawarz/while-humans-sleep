# Import Plan to Beads

Import a planning document into a WHS project's beads database.

## Usage

```
/whs-import-plan <file>
```

`$ARGUMENTS` is the path to the plan file.

## Instructions

When this skill is invoked, follow these steps:

### Step 1: Validate File

Check that the file at `$ARGUMENTS` exists. If no argument is provided, ask the user for the file path.

### Step 2: Read and Analyze the Plan

Read the file. The plan could be in **any format** — free-form prose, numbered lists, bullet points, a conversation excerpt, a design doc, or already structured with headers. Your job is to understand the content and convert it into the exact format that `whs import` expects.

### Step 3: Convert to Import Format

The `whs import` parser is strict. The file must use this exact format:

```markdown
# Epic: Title of the epic

Optional epic description text here.

## Story: Title of the story
**Priority**: 2
**Type**: task
**Depends on**: Other story title, Another story

Optional story description text here.

## Story: Another story
**Priority**: 1
**Type**: feature

Description of this story.
```

**Parser rules:**
- Epic headers: `# Epic: <title>` (h1 with `Epic:` prefix, case-insensitive)
- Story headers: `## Story: <title>` (h2 with `Story:` prefix, case-insensitive)
- Stories must appear after an epic header
- Metadata lines are optional, only recognized inside stories:
  - `**Priority**: <0-4>` — 0 is critical, 4 is low. Default: 2
  - `**Type**: <task|bug|feature|chore>` — Default: task
  - `**Depends on**: <title1>, <title2>` — Comma-separated story titles
- Everything else after a header becomes the description (free-form markdown)

**How to convert an arbitrary plan:**

1. **Identify epics** — Look for major themes, phases, or top-level groupings. If the plan is small or has a single theme, one epic is fine.
2. **Identify stories** — Each discrete unit of work becomes a story. A story should be a task an agent can complete in one session (create a PR, fix a bug, add a feature, write tests, etc.). If a plan item is too large, break it into multiple stories.
3. **Assign priorities** — Based on importance/urgency cues in the plan. If no cues, default to 2.
4. **Set types** — `feature` for new functionality, `bug` for fixes, `chore` for maintenance/config, `task` for everything else.
5. **Infer dependencies** — If the plan describes ordering ("after X", "requires Y first", numbered steps), express those as `**Depends on**:` lines referencing other story titles.
6. **Preserve context** — Important details, acceptance criteria, technical notes, and constraints from the original plan should go into story descriptions so the implementing agent has full context.

**Show the user the converted file** before writing it. Explain any judgment calls you made (how you grouped things, what you split, dependency choices). Write the converted file after the user approves — use the same path, or a new path if the user prefers to keep the original.

### Step 4: Dry Run

Run the dry-run preview so the user can see what will be created:

```bash
whs import <file> --dry-run
```

If the command reports errors, fix the file and retry.

If the project can't be inferred from CWD, add `--project <name>`.

### Step 5: Confirm with User

Ask the user:
1. Does the import preview look correct?
2. Should epics run in parallel? (Use `--parallel` to allow imported epics to run alongside existing epics instead of queuing behind them)

### Step 6: Import

Run the actual import:

```bash
whs import <file> [--project <name>] [--parallel]
```

Add `--project <name>` if the project can't be inferred from CWD.
Add `--parallel` if the user requested it in Step 5.

### Step 7: Report Results

Show the user the output. Confirm the epics and stories were created successfully.
