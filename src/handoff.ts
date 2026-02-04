/**
 * Handoff Parsing - Trust but verify pattern
 *
 * Attempts to parse handoff from agent output, falls back to forcing
 * handoff via tool call if parsing fails.
 */

import { parse as parseYaml } from "yaml";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Handoff } from "./types.js";

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
 * Schema for the Handoff custom tool
 */
export const HANDOFF_TOOL_SCHEMA = {
  name: "Handoff",
  description:
    "REQUIRED: Call this to complete your work and hand off to the next agent",
  input_schema: {
    type: "object" as const,
    properties: {
      next_agent: {
        type: "string",
        enum: VALID_AGENTS,
        description: "The next agent to handle this work",
      },
      pr_number: {
        type: "number",
        description: "PR number if one was created or exists",
      },
      ci_status: {
        type: "string",
        enum: ["pending", "passed", "failed"],
        description: "CI status if applicable",
      },
      context: {
        type: "string",
        description: "What you did and what the next agent needs to know",
      },
    },
    required: ["next_agent", "context"],
  },
};

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
 * Forces a handoff via tool call by resuming the session
 *
 * Used when tryParseHandoff fails to extract handoff from output.
 */
export async function forceHandoffViaTool(
  sessionId: string,
  cwd: string
): Promise<Handoff | null> {
  const prompt =
    "Your handoff was missing or malformed. You MUST call the Handoff tool now to complete your work.";

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd,
        resume: sessionId,
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Note: Custom tools would be configured via MCP server
        // For now, we'll parse from the output
      },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("name" in block && block.name === "Handoff") {
            const input = "input" in block ? block.input : undefined;
            if (input && typeof input === "object") {
              const handoff = validateHandoff(input as Record<string, unknown>);
              if (handoff) return handoff;
            }
          }
          // Also try to parse from text output
          if ("text" in block && block.text) {
            const parsed = tryParseHandoff(block.text);
            if (parsed) return parsed;
          }
        }
      }
    }
  } catch (err) {
    console.error(
      `Failed to force handoff via tool: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return null;
}

/**
 * Gets handoff from agent output using trust-but-verify pattern
 *
 * 1. Try to parse handoff from output
 * 2. If parsing fails, resume session and force handoff via tool
 * 3. Return fallback BLOCKED handoff if all else fails
 */
export async function getHandoff(
  output: string,
  sessionId: string,
  cwd: string
): Promise<Handoff> {
  // 1. Try to parse from output
  const parsed = tryParseHandoff(output);
  if (parsed) {
    return parsed;
  }

  // 2. Try to force via tool
  console.log("Handoff not found in output, requesting via tool...");
  const forced = await forceHandoffViaTool(sessionId, cwd);
  if (forced) {
    return forced;
  }

  // 3. Fallback
  console.warn("Failed to get handoff, returning BLOCKED");
  return {
    next_agent: "BLOCKED",
    context: "Agent failed to produce a valid handoff. Manual intervention required.",
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
