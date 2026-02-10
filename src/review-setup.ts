/**
 * Review Setup - Propagate structured code review format into managed projects
 *
 * This module copies the review output format template into projects and
 * updates CI workflows that use claude-code-action to reference the format.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/** Relative path where the review format doc lives in both WHS and target projects */
const REVIEW_FORMAT_REL_PATH = "docs/llm/code-review-output-format.md";

/** The CI review prompt that references the format doc */
export const CI_REVIEW_PROMPT = `Review this pull request following the structured format in docs/llm/code-review-output-format.md.

You MUST include a verdict line: **Verdict:** PASS or **Verdict:** NEEDS_CHANGES

Categorize all findings by severity:
- Critical (must fix before merge)
- Major (should fix before merge)
- Minor (non-blocking, nice to have)

Always include a Positive section noting what was done well.

Use the repository's CLAUDE.md for guidance on style and conventions.

Use \`gh pr comment\` with your Bash tool to leave your review as a comment on the PR.`;

/**
 * Get the path to the source review format doc in the WHS repo
 */
function getSourceFormatPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const srcDir = dirname(thisFile);
  const repoRoot = dirname(srcDir);
  return join(repoRoot, REVIEW_FORMAT_REL_PATH);
}

/**
 * Check if a project already has the review format doc
 */
export function hasReviewFormat(projectPath: string): boolean {
  return existsSync(join(projectPath, REVIEW_FORMAT_REL_PATH));
}

/**
 * Copy the review format doc into a project's docs/llm/ directory
 */
export function copyReviewFormat(projectPath: string): void {
  const sourcePath = getSourceFormatPath();
  if (!existsSync(sourcePath)) {
    throw new Error(`Review format source not found: ${sourcePath}`);
  }

  const content = readFileSync(sourcePath, "utf-8");
  const targetPath = join(projectPath, REVIEW_FORMAT_REL_PATH);
  const targetDir = dirname(targetPath);

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  writeFileSync(targetPath, content);
}

/** Info about a workflow that uses claude-code-action */
export interface ClaudeReviewWorkflow {
  /** Absolute path to the workflow file */
  path: string;
  /** Name of the workflow file */
  filename: string;
}

/**
 * Find GitHub Actions workflows that use claude-code-action
 */
export function findClaudeReviewWorkflows(projectPath: string): ClaudeReviewWorkflow[] {
  const workflowsDir = join(projectPath, ".github", "workflows");
  if (!existsSync(workflowsDir)) {
    return [];
  }

  const results: ClaudeReviewWorkflow[] = [];

  const files = readdirSync(workflowsDir);

  for (const file of files) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) {
      continue;
    }

    const fullPath = join(workflowsDir, file);
    const content = readFileSync(fullPath, "utf-8");

    if (content.includes("anthropics/claude-code-action")) {
      results.push({
        path: fullPath,
        filename: file,
      });
    }
  }

  return results;
}

/** Result of attempting to update a workflow's review prompt */
export interface UpdateResult {
  updated: boolean;
  reason: string;
}

/**
 * Update a workflow's claude-review prompt to use the structured format.
 *
 * Finds the `prompt: |` block under the claude-code-action step and replaces
 * its content with CI_REVIEW_PROMPT.
 */
export function updateWorkflowReviewPrompt(workflowPath: string): UpdateResult {
  if (!existsSync(workflowPath)) {
    return { updated: false, reason: "File not found" };
  }

  const content = readFileSync(workflowPath, "utf-8");

  if (!content.includes("anthropics/claude-code-action")) {
    return { updated: false, reason: "No claude-code-action step found" };
  }

  // Check if already up to date
  if (content.includes("docs/llm/code-review-output-format.md")) {
    return { updated: false, reason: "Already references review format" };
  }

  // Find the prompt block under claude-code-action
  // The pattern is:
  //   uses: anthropics/claude-code-action@...
  //   with:
  //     ...
  //     prompt: |
  //       <multiline prompt content>
  //     claude_args: ...  (or next key at same indent)

  const lines = content.split("\n");
  let inClaudeAction = false;
  let inWith = false;
  let promptStartLine = -1;
  let promptEndLine = -1;
  let promptIndent = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (trimmed.startsWith("uses: anthropics/claude-code-action")) {
      inClaudeAction = true;
      continue;
    }

    if (inClaudeAction && trimmed.startsWith("with:")) {
      inWith = true;
      continue;
    }

    if (inClaudeAction && inWith && trimmed.startsWith("prompt:")) {
      // Found the prompt key
      promptStartLine = i;
      // Determine the indent of the prompt key
      const keyIndent = line.length - trimmed.length;
      promptIndent = " ".repeat(keyIndent + 2); // content is indented 2 more than the key

      // Find where the prompt content ends
      // It ends when we hit a line at the same or lesser indent as 'prompt:'
      // (i.e., the next sibling key under 'with:')
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        // Empty lines are part of the block
        if (nextLine.trim() === "") {
          continue;
        }
        const nextIndent = nextLine.length - nextLine.trimStart().length;
        if (nextIndent <= keyIndent) {
          promptEndLine = j;
          break;
        }
      }

      if (promptEndLine === -1) {
        // Prompt goes to end of file
        promptEndLine = lines.length;
      }

      break;
    }

    // Reset if we leave the claude-code-action step
    if (inClaudeAction && !trimmed.startsWith("-") && !trimmed.startsWith("uses:") && !inWith) {
      if (trimmed.startsWith("- ")) {
        inClaudeAction = false;
        inWith = false;
      }
    }
  }

  if (promptStartLine === -1) {
    return { updated: false, reason: "Could not find prompt field in claude-code-action step" };
  }

  // Build the new prompt block
  const promptLines = CI_REVIEW_PROMPT.split("\n").map((l) =>
    l === "" ? "" : promptIndent + l
  );
  const newPromptBlock = [
    lines[promptStartLine].replace(/prompt:.*/, "prompt: |"),
    ...promptLines,
    "",
  ];

  // Replace the old prompt block
  const newLines = [
    ...lines.slice(0, promptStartLine),
    ...newPromptBlock,
    ...lines.slice(promptEndLine),
  ];

  writeFileSync(workflowPath, newLines.join("\n"));
  return { updated: true, reason: "Updated prompt to use structured review format" };
}
