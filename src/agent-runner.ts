/**
 * Agent Runner - Claude Agent SDK wrapper
 *
 * Runs agents via the Claude Agent SDK, handling streaming output,
 * session management, cost tracking, and AskUserQuestion tool calls.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Question, PendingQuestion } from "./types.js";
import { recordStepComplete } from "./metrics.js";
import { resolve, relative, isAbsolute } from "path";

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
 * Tracking state for metrics recording
 */
interface MetricsContext {
  stepId?: string;
  workflowId?: string;
  agent?: string;
}

/**
 * Options for running an agent
 */
export interface RunAgentOptions {
  /** Path to agent definition markdown file (optional, uses systemPrompt if not provided) */
  agentFile?: string;
  /** Custom system prompt (used if agentFile not provided) */
  systemPrompt?: string;
  /** Working directory for the agent */
  cwd: string;
  /** Maximum turns before stopping */
  maxTurns?: number;
  /** Session ID to resume (for continuing after questions) */
  resume?: string;
  /** Allowed tools (defaults to all) */
  allowedTools?: string[];
  /** Callback for streaming output */
  onOutput?: (text: string) => void;
  /** Callback for tool use */
  onToolUse?: (toolName: string, input: unknown) => void;
  /** Enable safety hooks (blocks dangerous commands, worktree escaping) */
  enableSafetyHooks?: boolean;
  /** Metrics context for recording step completion */
  metricsContext?: MetricsContext;
}

/**
 * Result of running an agent
 */
export interface AgentRunResult {
  /** Session ID for resumption */
  sessionId: string;
  /** Collected text output from the agent */
  output: string;
  /** Total cost in USD */
  costUsd: number;
  /** Number of turns taken */
  turns: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the agent completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Pending question if agent asked for user input */
  pendingQuestion?: {
    questions: Question[];
    context: string;
  };
}

/**
 * Runs an agent via the Claude Agent SDK
 */
export async function runAgent(
  prompt: string,
  options: RunAgentOptions
): Promise<AgentRunResult> {
  let sessionId = options.resume || "";
  let output = "";
  let costUsd = 0;
  let turns = 0;
  let durationMs = 0;
  let success = true;
  let error: string | undefined;
  let pendingQuestion: AgentRunResult["pendingQuestion"] | undefined;

  try {
    // Build hooks if safety is enabled
    const hooks = options.enableSafetyHooks !== false ? buildHooks(options.cwd) : undefined;

    const queryOptions: Parameters<typeof query>[0]["options"] = {
      cwd: options.cwd,
      // Load project's CLAUDE.md and settings
      settingSources: ["project"],
      // Use Claude Code's system prompt as base, append custom if provided
      systemPrompt: options.systemPrompt
        ? { type: "preset", preset: "claude_code", append: options.systemPrompt }
        : { type: "preset", preset: "claude_code" },
      // Use Claude Code's default tools
      tools: { type: "preset", preset: "claude_code" },
      // Allow all tools by default, or restrict if specified
      allowedTools: options.allowedTools,
      // Maximum turns
      maxTurns: options.maxTurns ?? 50,
      // Resume session if provided
      resume: options.resume,
      // Bypass permissions for automated operation
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Safety hooks
      hooks,
    };

    // Stream messages from the agent
    for await (const message of query({ prompt, options: queryOptions })) {
      // Handle different message types
      switch (message.type) {
        case "system":
          if (message.subtype === "init") {
            sessionId = message.session_id;
          }
          break;

        case "assistant":
          // Extract text content from assistant messages
          if (message.message?.content) {
            for (const block of message.message.content) {
              if ("text" in block && block.text) {
                output += block.text + "\n";
                options.onOutput?.(block.text);
              } else if ("name" in block) {
                // Tool use block
                const toolName = block.name;
                const toolInput = "input" in block ? block.input : undefined;
                options.onToolUse?.(toolName, toolInput);

                // Check for AskUserQuestion tool
                if (toolName === "AskUserQuestion" && toolInput) {
                  const input = toolInput as {
                    questions?: Question[];
                    answers?: Record<string, string>;
                  };

                  // If no answers yet, this is a pending question
                  if (input.questions && !input.answers) {
                    pendingQuestion = {
                      questions: input.questions,
                      context: output.slice(-500), // Last 500 chars for context
                    };
                  }
                }
              }
            }
          }
          break;

        case "result":
          // Final result message
          costUsd = message.total_cost_usd;
          turns = message.num_turns;
          durationMs = message.duration_ms;
          success = message.subtype === "success";

          if (message.subtype !== "success" && "errors" in message) {
            error = message.errors?.join("; ");
          }
          break;
      }
    }
  } catch (err) {
    success = false;
    error = err instanceof Error ? err.message : String(err);
  }

  // Record metrics if context provided
  if (options.metricsContext?.stepId && !pendingQuestion) {
    try {
      const outcome = success ? "success" : (error || "unknown_error");
      recordStepComplete(options.metricsContext.stepId, costUsd, outcome);
    } catch {
      // Don't fail the run if metrics recording fails
      console.warn("Failed to record step metrics");
    }
  }

  return {
    sessionId,
    output: output.trim(),
    costUsd,
    turns,
    durationMs,
    success,
    error,
    pendingQuestion,
  };
}

/**
 * Resumes an agent session with an answer to a question
 */
export async function resumeWithAnswer(
  sessionId: string,
  answer: string,
  options: Omit<RunAgentOptions, "resume">
): Promise<AgentRunResult> {
  return runAgent(answer, {
    ...options,
    resume: sessionId,
  });
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
 * Builds the hooks configuration for the SDK
 * Note: This returns a hooks object compatible with the Claude Agent SDK
 */
function buildHooks(worktreePath: string): Record<string, unknown> {
  const bashHook = createBashSafetyHook(worktreePath);
  const fileHook = createFileSafetyHook(worktreePath);

  return {
    PreToolUse: [
      {
        // Hook for Bash commands
        matcher: /^Bash$/,
        hooks: [
          async ({ toolInput }: { toolInput: { command?: string } }) => {
            if (!toolInput.command) return {};
            return bashHook({ command: toolInput.command });
          },
        ],
      },
      {
        // Hook for Write tool
        matcher: /^Write$/,
        hooks: [
          async ({ toolInput }: { toolInput: { file_path?: string } }) => {
            return fileHook(toolInput);
          },
        ],
      },
      {
        // Hook for Edit tool
        matcher: /^Edit$/,
        hooks: [
          async ({ toolInput }: { toolInput: { file_path?: string } }) => {
            return fileHook(toolInput);
          },
        ],
      },
    ],
  };
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
