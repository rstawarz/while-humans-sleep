/**
 * Agent Runner Interface
 *
 * Defines the contract that both CLI and SDK agent runners must implement.
 * This allows swapping between runners without changing the dispatcher.
 */

import type { Question } from "./types.js";

/**
 * Options for running an agent
 */
export interface AgentRunOptions {
  /** The prompt/task for the agent */
  prompt: string;

  /** Working directory for the agent */
  cwd: string;

  /** Maximum turns before stopping */
  maxTurns?: number;

  /** Session ID to resume (for continuing after questions) */
  resume?: string;

  /** Custom system prompt to append */
  systemPrompt?: string;

  /** Agent definition file path */
  agentFile?: string;

  /** Allowed tools (defaults to all) */
  allowedTools?: string[];

  /** Callback for streaming output */
  onOutput?: (text: string) => void;

  /** Callback for tool use events */
  onToolUse?: (toolName: string, input: unknown) => void;

  /** Log file path for CLI runner (enables tailing) */
  logFile?: string;

  /** Metrics context for recording */
  metricsContext?: {
    stepId?: string;
    workflowId?: string;
    agent?: string;
  };
}

/**
 * Result of running an agent
 */
export interface AgentRunResult {
  /** Session ID for resumption */
  sessionId: string;

  /** Collected text output from the agent */
  output: string;

  /** Total cost in USD (0 for CLI runner using Max subscription) */
  costUsd: number;

  /** Number of turns taken */
  turns: number;

  /** Duration in milliseconds */
  durationMs: number;

  /** Whether the agent completed successfully */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** Whether the error was an authentication failure */
  isAuthError?: boolean;

  /** Pending question if agent asked for user input */
  pendingQuestion?: {
    questions: Question[];
    context: string;
  };
}

/**
 * Agent Runner interface
 *
 * Both CLI and SDK runners implement this interface, allowing the dispatcher
 * to use either one interchangeably.
 */
export interface AgentRunner {
  /**
   * Run an agent with the given prompt and options
   */
  run(options: AgentRunOptions): Promise<AgentRunResult>;

  /**
   * Resume a session with an answer to a pending question
   */
  resumeWithAnswer(
    sessionId: string,
    answer: string,
    options: Omit<AgentRunOptions, "prompt" | "resume">
  ): Promise<AgentRunResult>;

  /**
   * Abort all running agents
   * Called during force stop to kill processes immediately
   */
  abort(): void;
}

/**
 * Factory function type for creating agent runners
 */
export type AgentRunnerFactory = () => AgentRunner;

/**
 * Available runner types
 */
export type AgentRunnerType = "cli" | "sdk";
