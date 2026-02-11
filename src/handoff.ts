/**
 * Handoff Parsing - Trust but verify pattern
 *
 * Detection order:
 * 1. Check for .whs-handoff.json file in worktree (most reliable - persists on crash)
 * 2. Parse handoff from agent text output (YAML/JSON blocks)
 * 3. Resume session via agent runner asking for handoff (maxTurns: 3)
 * 4. Fallback: return BLOCKED
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import type { AgentRunner } from "./agent-runner-interface.js";
import type { Handoff } from "./types.js";

/**
 * Filename for file-based handoff mechanism.
 * Agents write this file via `whs handoff` command.
 */
export const HANDOFF_FILENAME = ".whs-handoff.json";

/**
 * Prompt used when resuming a session to force a handoff
 */
export const FORCE_HANDOFF_PROMPT = `Your previous work did not include a handoff. You MUST provide one now.

Run this command to record your handoff:

whs handoff --next-agent <AGENT> --context "Brief summary of what you did and what the next agent needs to know"

Valid values for --next-agent:
- implementation - for code changes needed
- quality_review - for PR review
- release_manager - for merging an approved PR
- DONE - task is fully complete
- BLOCKED - human intervention needed

Optional flags: --pr-number <N> --ci-status <pending|passed|failed>

If the whs command is not available, output your handoff as a YAML block:

\`\`\`yaml
next_agent: <AGENT>
context: |
  Brief summary of what you did
\`\`\``;

/**
 * Valid agent names for handoff
 */
export const VALID_AGENTS = [
  "implementation",
  "quality_review",
  "release_manager",
  "ux_specialist",
  "architect",
  "planner",
  "DONE",
  "BLOCKED",
] as const;

export type ValidAgent = (typeof VALID_AGENTS)[number];

/**
 * Attempts to parse a handoff from agent output
 *
 * Looks for YAML or JSON blocks containing handoff data.
 * Returns null if no valid handoff found.
 */
export function tryParseHandoff(output: string): Handoff | null {
  // Try to find YAML block (```yaml ... ```)
  const yamlMatch = output.match(/```ya?ml\s*\n([\s\S]*?)\n```/i);
  if (yamlMatch) {
    const parsed = tryParseYamlHandoff(yamlMatch[1]);
    if (parsed) return parsed;
  }

  // Try to find JSON block (```json ... ```)
  const jsonMatch = output.match(/```json\s*\n([\s\S]*?)\n```/i);
  if (jsonMatch) {
    const parsed = tryParseJsonHandoff(jsonMatch[1]);
    if (parsed) return parsed;
  }

  // Try to find inline YAML (next_agent: ... at start of line)
  const inlineYamlMatch = output.match(
    /^next_agent:\s*(\S+)[\s\S]*?^context:\s*(.+?)(?=\n\S|\n*$)/m
  );
  if (inlineYamlMatch) {
    // Extract the full YAML section
    const startIndex = output.indexOf(inlineYamlMatch[0]);
    const endIndex = findYamlEndIndex(output, startIndex);
    const yamlSection = output.slice(startIndex, endIndex);
    const parsed = tryParseYamlHandoff(yamlSection);
    if (parsed) return parsed;
  }

  // Try to find handoff anywhere in the last part of output
  const lastSection = output.slice(-2000);
  const looseYamlMatch = lastSection.match(
    /next_agent:\s*["']?(\w+)["']?\s*(?:[\s\S]*?context:\s*[|>]?\s*([\s\S]*?))?(?=\n[a-z_]+:|$)/i
  );
  if (looseYamlMatch) {
    const nextAgent = looseYamlMatch[1];
    if (isValidAgent(nextAgent)) {
      return {
        next_agent: nextAgent,
        context: looseYamlMatch[2]?.trim() || "No context provided",
      };
    }
  }

  return null;
}

/**
 * Parse YAML string into Handoff
 */
function tryParseYamlHandoff(yamlStr: string): Handoff | null {
  try {
    const parsed = parseYaml(yamlStr) as Record<string, unknown>;
    return validateHandoff(parsed);
  } catch {
    return null;
  }
}

/**
 * Parse JSON string into Handoff
 */
function tryParseJsonHandoff(jsonStr: string): Handoff | null {
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return validateHandoff(parsed);
  } catch {
    return null;
  }
}

/**
 * Validate and normalize a parsed object into a Handoff
 */
function validateHandoff(obj: Record<string, unknown>): Handoff | null {
  const nextAgent = obj.next_agent ?? obj.nextAgent;
  const context = obj.context ?? obj.summary ?? obj.message;

  if (typeof nextAgent !== "string" || !isValidAgent(nextAgent)) {
    return null;
  }

  if (typeof context !== "string") {
    return null;
  }

  const handoff: Handoff = {
    next_agent: nextAgent,
    context: context,
  };

  // Optional fields
  const prNumber = obj.pr_number ?? obj.prNumber ?? obj.pr;
  if (typeof prNumber === "number") {
    handoff.pr_number = prNumber;
  } else if (typeof prNumber === "string") {
    const parsed = parseInt(prNumber, 10);
    if (!isNaN(parsed)) {
      handoff.pr_number = parsed;
    }
  }

  const ciStatus = obj.ci_status ?? obj.ciStatus ?? obj.ci;
  if (
    ciStatus === "pending" ||
    ciStatus === "passed" ||
    ciStatus === "failed"
  ) {
    handoff.ci_status = ciStatus;
  }

  return handoff;
}

/**
 * Check if a string is a valid agent name
 */
export function isValidAgent(agent: string): agent is ValidAgent {
  return VALID_AGENTS.includes(agent as ValidAgent);
}

/**
 * Find the end index of a YAML section
 */
function findYamlEndIndex(text: string, startIndex: number): number {
  const lines = text.slice(startIndex).split("\n");
  let endOffset = 0;
  let inMultilineValue = false;
  let baseIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    endOffset += line.length + 1;

    // Check for multiline indicator
    if (line.match(/:\s*[|>]/)) {
      inMultilineValue = true;
      baseIndent = line.search(/\S/);
      continue;
    }

    if (inMultilineValue) {
      const indent = line.search(/\S/);
      if (indent !== -1 && indent <= baseIndent && line.match(/^\s*\w+:/)) {
        inMultilineValue = false;
      } else {
        continue;
      }
    }

    // Empty line or non-YAML line signals end
    if (line.trim() === "" || (i > 0 && !line.match(/^\s*[\w-]+:/))) {
      // Check if next line continues YAML
      const nextLine = lines[i + 1];
      if (!nextLine || !nextLine.match(/^\s*[\w-]+:/)) {
        break;
      }
    }
  }

  return startIndex + endOffset;
}

/**
 * Reads a handoff from the .whs-handoff.json file in the worktree.
 *
 * This is the most reliable handoff mechanism — the file is written by
 * the `whs handoff` CLI command and persists even if the agent crashes
 * after writing it.
 */
export function readHandoffFile(worktreePath: string): Handoff | null {
  const filePath = join(worktreePath, HANDOFF_FILENAME);

  try {
    if (!existsSync(filePath)) return null;

    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return validateHandoff(parsed);
  } catch (err) {
    console.warn(
      `Failed to read handoff file: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Writes a handoff file to the specified directory.
 * Used by the `whs handoff` CLI command.
 */
export function writeHandoffFile(
  dir: string,
  handoff: Handoff
): void {
  const filePath = join(dir, HANDOFF_FILENAME);
  writeFileSync(filePath, JSON.stringify(handoff, null, 2) + "\n");
}

/**
 * Removes the handoff file after it has been read.
 */
export function cleanHandoffFile(worktreePath: string): void {
  const filePath = join(worktreePath, HANDOFF_FILENAME);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Best effort cleanup
  }
}

/**
 * Forces a handoff by resuming the session and asking the agent explicitly.
 *
 * Uses the same agent runner that ran the original session, so it works
 * with both CLI and SDK runners. Gives the agent 3 turns to produce a
 * handoff via `whs handoff` command or YAML output.
 */
export async function forceHandoffViaResume(
  sessionId: string,
  cwd: string,
  runner: AgentRunner
): Promise<Handoff | null> {
  try {
    const result = await runner.resumeWithAnswer(sessionId, FORCE_HANDOFF_PROMPT, {
      cwd,
      maxTurns: 10,
    });

    // Check for handoff file first (agent may have used `whs handoff`)
    const fromFile = readHandoffFile(cwd);
    if (fromFile) {
      cleanHandoffFile(cwd);
      return fromFile;
    }

    // Try to parse from output text
    return tryParseHandoff(result.output);
  } catch (err) {
    console.error(
      `Failed to force handoff via resume: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Gets handoff from agent output using trust-but-verify pattern
 *
 * Detection order:
 * 1. Check for .whs-handoff.json file in worktree (most reliable)
 * 2. Parse handoff from agent text output
 * 3. Resume session via agent runner asking for handoff (maxTurns: 3)
 * 4. Return fallback BLOCKED handoff if all else fails
 */
export async function getHandoff(
  output: string,
  sessionId: string,
  cwd: string,
  runner?: AgentRunner
): Promise<Handoff> {
  // 1. Check for handoff file (most reliable — persists across crashes)
  const fromFile = readHandoffFile(cwd);
  if (fromFile) {
    cleanHandoffFile(cwd);
    return fromFile;
  }

  // 2. Try to parse from output
  const parsed = tryParseHandoff(output);
  if (parsed) {
    return parsed;
  }

  // 3. Resume session and ask for handoff
  if (runner) {
    console.log("Handoff not found in output, resuming session to request...");
    const forced = await forceHandoffViaResume(sessionId, cwd, runner);
    if (forced) {
      return forced;
    }
  }

  // 4. Fallback — include tail of agent output for diagnostics
  console.warn("Failed to get handoff, returning BLOCKED");
  const outputTail = output.trim().split("\n").slice(-20).join("\n");
  return {
    next_agent: "BLOCKED",
    context: `Agent failed to produce a valid handoff. Manual intervention required.\n\nLast agent output:\n${outputTail}`,
  };
}

/**
 * Formats a handoff as a YAML string for display
 */
export function formatHandoff(handoff: Handoff): string {
  const lines = [`next_agent: ${handoff.next_agent}`];

  if (handoff.pr_number !== undefined) {
    lines.push(`pr_number: ${handoff.pr_number}`);
  }

  if (handoff.ci_status !== undefined) {
    lines.push(`ci_status: ${handoff.ci_status}`);
  }

  // Handle multiline context
  if (handoff.context.includes("\n")) {
    lines.push("context: |");
    for (const line of handoff.context.split("\n")) {
      lines.push(`  ${line}`);
    }
  } else {
    lines.push(`context: ${handoff.context}`);
  }

  return lines.join("\n");
}
