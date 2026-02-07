/**
 * Agent Runner Utilities
 *
 * Shared utilities for agent runners including safety hooks, validation,
 * and prompt formatting. The actual runner implementations are in:
 * - cli-agent-runner.ts (uses claude CLI, runs on Max subscription)
 * - claude-sdk-agent-runner.ts (uses Claude Agent SDK, pay-per-token)
 */

import { resolve, relative, isAbsolute } from "path";

// Re-export types from the interface for backward compatibility
export type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  AgentRunnerFactory,
  AgentRunnerType,
} from "./agent-runner-interface.js";

// Re-export SDK types we need
export type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// === Safety Hooks Configuration ===

/**
 * Dangerous command patterns that should be blocked
 * These patterns match against the command string in Bash tool calls
 */
export const DANGEROUS_COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  // Destructive file operations
  { pattern: /rm\s+(-[rf]+\s+)*\/(?!\S)/, reason: "rm on root directory" },
  { pattern: /rm\s+(-[rf]+\s+)*~\//, reason: "rm on home directory" },
  { pattern: /rm\s+-[rf]*\s+\*/, reason: "recursive rm with wildcard" },

  // Force push to protected branches
  { pattern: /git\s+push\s+.*--force/, reason: "force push" },
  { pattern: /git\s+push\s+-f/, reason: "force push" },
  { pattern: /git\s+push\s+.*origin\s+(main|master)\s+--force/, reason: "force push to main" },

  // Destructive git operations
  { pattern: /git\s+reset\s+--hard/, reason: "hard reset" },
  { pattern: /git\s+clean\s+-[fd]+/, reason: "git clean with force" },

  // System-level danger
  { pattern: /chmod\s+-R\s+777/, reason: "recursive chmod 777" },
  { pattern: /chown\s+-R/, reason: "recursive chown" },
  { pattern: /mkfs/, reason: "filesystem format" },
  { pattern: /dd\s+.*of=\/dev/, reason: "dd to device" },

  // Credential/secret exposure
  { pattern: /curl.*\|\s*sh/, reason: "piping curl to shell" },
  { pattern: /wget.*\|\s*sh/, reason: "piping wget to shell" },

  // Process/system manipulation
  { pattern: /kill\s+-9\s+1\b/, reason: "killing init" },
  { pattern: /killall/, reason: "killall command" },
  { pattern: /shutdown/, reason: "shutdown command" },
  { pattern: /reboot/, reason: "reboot command" },
];

/**
 * Hook result type
 */
export interface HookResult {
  decision?: "allow" | "deny";
  message?: string;
}

/**
 * Checks if a command is dangerous
 */
export function isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { dangerous: true, reason };
    }
  }
  return { dangerous: false };
}

/**
 * Checks if a path escapes the worktree directory
 */
export function escapesWorktree(targetPath: string, worktreePath: string): boolean {
  // Resolve both paths to absolute
  const resolvedTarget = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(worktreePath, targetPath);
  const resolvedWorktree = resolve(worktreePath);

  // Check if target is within worktree
  const relativePath = relative(resolvedWorktree, resolvedTarget);

  // If relative path starts with ".." or is absolute, it escapes
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}

/**
 * Creates a PreToolUse hook for the Bash tool that blocks dangerous commands
 */
export function createBashSafetyHook(worktreePath: string): (input: { command: string }) => HookResult {
  return (input: { command: string }) => {
    const { command } = input;

    // Check for dangerous commands
    const { dangerous, reason } = isDangerousCommand(command);
    if (dangerous) {
      return {
        decision: "deny",
        message: `Blocked dangerous command: ${reason}`,
      };
    }

    // Check for path escaping in common commands
    // Look for cd commands that escape
    const cdMatch = command.match(/cd\s+["']?([^"';\s]+)/);
    if (cdMatch && escapesWorktree(cdMatch[1], worktreePath)) {
      return {
        decision: "deny",
        message: `Blocked: cd would escape worktree directory`,
      };
    }

    return {};
  };
}

/**
 * Creates a PreToolUse hook for Write/Edit tools that blocks writes outside worktree
 */
export function createFileSafetyHook(worktreePath: string): (input: { file_path?: string; path?: string }) => HookResult {
  return (input: { file_path?: string; path?: string }) => {
    const filePath = input.file_path || input.path;
    if (!filePath) return {};

    if (escapesWorktree(filePath, worktreePath)) {
      return {
        decision: "deny",
        message: `Blocked: file operation would escape worktree directory`,
      };
    }

    return {};
  };
}

/**
 * Auth error patterns to detect
 */
const AUTH_ERROR_PATTERNS = [
  /invalid api key/i,
  /authentication[_\s]?failed/i,
  /please run \/login/i,
  /unauthorized/i,
  /api key.*invalid/i,
  /token.*expired/i,
  /oauth.*error/i,
];

/**
 * Checks if an error or output indicates an auth failure
 */
export function isAuthenticationError(text: string): boolean {
  return AUTH_ERROR_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Creates a formatted prompt for an agent from a work item
 */
export function formatAgentPrompt(params: {
  taskTitle: string;
  taskDescription: string;
  workflowContext?: string;
  agentRole: string;
}): string {
  const lines: string[] = [];

  lines.push(`# Task: ${params.taskTitle}`);
  lines.push("");
  lines.push("## Description");
  lines.push(params.taskDescription);

  if (params.workflowContext) {
    lines.push("");
    lines.push("## Workflow Context");
    lines.push(params.workflowContext);
  }

  lines.push("");
  lines.push("## Your Role");
  lines.push(params.agentRole);

  lines.push("");
  lines.push("## Handoff Instructions");
  lines.push("When you complete your work, output a handoff in this format:");
  lines.push("");
  lines.push("```yaml");
  lines.push("next_agent: <agent_name>");
  lines.push("pr_number: <number if applicable>");
  lines.push("ci_status: <pending|passed|failed if applicable>");
  lines.push("context: |");
  lines.push("  <Brief summary of what you did>");
  lines.push("  <What the next agent needs to know>");
  lines.push("```");
  lines.push("");
  lines.push("Valid next_agent values:");
  lines.push("- implementation - for code changes");
  lines.push("- quality_review - for PR review");
  lines.push("- release_manager - for merging");
  lines.push("- ux_specialist - for UI/UX work");
  lines.push("- architect - for complex decisions");
  lines.push("- DONE - when task is complete");
  lines.push("- BLOCKED - when human intervention needed");

  return lines.join("\n");
}

/**
 * Validates a command against safety rules without running it
 * Useful for testing and validation
 */
export function validateCommand(
  command: string,
  worktreePath: string
): { allowed: boolean; reason?: string } {
  // Check dangerous patterns
  const { dangerous, reason } = isDangerousCommand(command);
  if (dangerous) {
    return { allowed: false, reason };
  }

  // Check for cd escaping worktree
  const cdMatch = command.match(/cd\s+["']?([^"';\s]+)/);
  if (cdMatch && escapesWorktree(cdMatch[1], worktreePath)) {
    return { allowed: false, reason: "cd would escape worktree directory" };
  }

  return { allowed: true };
}

/**
 * Validates a file path against safety rules
 * Useful for testing and validation
 */
export function validateFilePath(
  filePath: string,
  worktreePath: string
): { allowed: boolean; reason?: string } {
  if (escapesWorktree(filePath, worktreePath)) {
    return { allowed: false, reason: "path escapes worktree directory" };
  }
  return { allowed: true };
}
