/**
 * CLI Agent Runner
 *
 * Runs agents via the `claude` CLI instead of the SDK.
 * Uses the user's Claude Max subscription instead of API credits.
 */

import { spawn, type ChildProcess } from "child_process";
import { createWriteStream, type WriteStream } from "fs";
import type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
} from "./agent-runner-interface.js";
import type { Question } from "./types.js";

/**
 * Auth error patterns to detect in CLI output
 */
const AUTH_ERROR_PATTERNS = [
  /invalid api key/i,
  /authentication[_\s]?failed/i,
  /please run \/login/i,
  /unauthorized/i,
  /token.*expired/i,
  /oauth.*error/i,
];

/**
 * Checks if text indicates an auth failure
 */
function isAuthenticationError(text: string): boolean {
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Message types from stream-json output
 */
interface StreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  error?: string;
  errors?: string[];
}

/**
 * CLI-based agent runner
 *
 * Uses the `claude` CLI which runs on the user's Max subscription.
 */
export class CLIAgentRunner implements AgentRunner {
  /** Track running processes for abort */
  private runningProcesses: Set<ChildProcess> = new Set();

  /**
   * Run an agent with the given prompt
   */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    return this.executeAgent(options.prompt, options);
  }

  /**
   * Resume a session with an answer
   *
   * CLI --resume doesn't support injecting tool results for AskUserQuestion.
   * The resumed session treats stdin as a new user message, not as the answer
   * to the pending AskUserQuestion tool call. This always fails, so we return
   * an empty result to signal the dispatcher should fall back to a fresh run.
   */
  async resumeWithAnswer(
    _sessionId: string,
    _answer: string,
    _options: Omit<AgentRunOptions, "prompt" | "resume">
  ): Promise<AgentRunResult> {
    return {
      sessionId: "",
      output: "",
      costUsd: 0,
      turns: 0,
      durationMs: 0,
      success: false,
      error: "CLI runner does not support session resume for question answers",
    };
  }

  /**
   * Execute the claude CLI and collect results
   */
  private async executeAgent(
    prompt: string,
    options: AgentRunOptions
  ): Promise<AgentRunResult> {
    const startTime = Date.now();
    let sessionId = options.resume || "";
    let output = "";
    let costUsd = 0;
    let turns = 0;
    let success = true;
    let error: string | undefined;
    let pendingQuestion: AgentRunResult["pendingQuestion"] | undefined;

    // Build CLI arguments (prompt goes via stdin)
    const args = this.buildArgs(options);

    // Set up log file if requested
    let logStream: WriteStream | undefined;
    if (options.logFile) {
      logStream = createWriteStream(options.logFile, { flags: "a" });
    }

    try {
      const result = await this.spawnClaude(args, options.cwd, logStream, options);

      sessionId = result.sessionId || sessionId;
      output = result.output;
      costUsd = result.costUsd;
      turns = result.turns;
      success = result.success;
      error = result.error;
      pendingQuestion = result.pendingQuestion;
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      logStream?.end();
    }

    const durationMs = Date.now() - startTime;
    const isAuthError = isAuthenticationError(output) || (error ? isAuthenticationError(error) : false);

    // When auth error is detected from output but error message is generic,
    // extract the auth-related line for a more useful error message
    if (isAuthError && error && !isAuthenticationError(error)) {
      const authLine = output.split("\n").find((line) => isAuthenticationError(line));
      if (authLine) {
        error = authLine.trim();
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
      isAuthError,
      pendingQuestion,
    };
  }

  /**
   * Build CLI arguments
   *
   * Note: Prompt is passed via stdin, not as an argument (avoids shell length limits)
   */
  private buildArgs(options: AgentRunOptions): string[] {
    const args: string[] = [
      "-p", // Print mode (non-interactive)
      "--output-format", "stream-json",
      "--dangerously-skip-permissions", // For automated operation
      "--verbose", // More detailed output
    ];

    // Resume session if provided
    if (options.resume) {
      args.push("--resume", options.resume);
    }

    // Max turns
    if (options.maxTurns) {
      args.push("--max-turns", String(options.maxTurns));
    }

    // Agent file
    if (options.agentFile) {
      args.push("--agent", options.agentFile);
    }

    // System prompt
    if (options.systemPrompt) {
      args.push("--append-system-prompt", options.systemPrompt);
    }

    // Allowed tools
    if (options.allowedTools?.length) {
      args.push("--allowed-tools", options.allowedTools.join(","));
    }

    // Note: prompt is NOT added here - it's piped via stdin

    return args;
  }

  /**
   * Spawn claude CLI and process output
   */
  private spawnClaude(
    args: string[],
    cwd: string,
    logStream: WriteStream | undefined,
    options: AgentRunOptions
  ): Promise<{
    sessionId: string;
    output: string;
    costUsd: number;
    turns: number;
    success: boolean;
    error?: string;
    pendingQuestion?: AgentRunResult["pendingQuestion"];
  }> {
    return new Promise((resolve, reject) => {
      const proc = spawn("claude", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Track this process for abort
      this.runningProcesses.add(proc);

      // Write prompt to stdin (avoids shell length limits)
      proc.stdin.write(options.prompt);
      proc.stdin.end();

      let sessionId = "";
      let output = "";
      let costUsd = 0;
      let turns = 0;
      let success = true;
      let error: string | undefined;
      let pendingQuestion: AgentRunResult["pendingQuestion"] | undefined;
      let buffer = "";
      let aborted = false;

      // Process stdout line by line
      proc.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        buffer += chunk;

        // Write to log file
        logStream?.write(chunk);

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const msg = JSON.parse(line) as StreamMessage;
            const result = this.processMessage(msg, options);

            if (result.sessionId) sessionId = result.sessionId;
            if (result.text) {
              output += result.text + "\n";
              options.onOutput?.(result.text);
            }
            if (result.costUsd !== undefined) costUsd = result.costUsd;
            if (result.turns !== undefined) turns = result.turns;
            if (result.success !== undefined) success = result.success;
            if (result.error) error = result.error;
            if (result.pendingQuestion) pendingQuestion = result.pendingQuestion;
            if (result.toolUse) {
              options.onToolUse?.(result.toolUse.name, result.toolUse.input);
            }
          } catch {
            // Not JSON, treat as plain text
            output += line + "\n";
            options.onOutput?.(line);
          }
        }
      });

      // Capture stderr
      let stderr = "";
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
        logStream?.write(data);
      });

      proc.on("close", (code, signal) => {
        // Remove from tracking
        this.runningProcesses.delete(proc);

        // Check if we were killed by abort
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          aborted = true;
        }

        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer) as StreamMessage;
            const result = this.processMessage(msg, options);
            if (result.sessionId) sessionId = result.sessionId;
            if (result.text) output += result.text + "\n";
            if (result.costUsd !== undefined) costUsd = result.costUsd;
            if (result.turns !== undefined) turns = result.turns;
            if (result.success !== undefined) success = result.success;
            if (result.error) error = result.error;
            if (result.pendingQuestion) pendingQuestion = result.pendingQuestion;
          } catch {
            output += buffer;
          }
        }

        if (aborted) {
          success = false;
          error = "Agent aborted by dispatcher shutdown";
        } else if (code !== 0 && !pendingQuestion) {
          success = false;
          error = error || stderr || `Process exited with code ${code}`;
        }

        resolve({
          sessionId,
          output,
          costUsd,
          turns,
          success,
          error,
          pendingQuestion,
        });
      });

      proc.on("error", (err) => {
        this.runningProcesses.delete(proc);
        reject(err);
      });
    });
  }

  /**
   * Process a stream-json message
   */
  private processMessage(
    msg: StreamMessage,
    options: AgentRunOptions
  ): {
    sessionId?: string;
    text?: string;
    costUsd?: number;
    turns?: number;
    success?: boolean;
    error?: string;
    pendingQuestion?: AgentRunResult["pendingQuestion"];
    toolUse?: { name: string; input: unknown };
  } {
    const result: ReturnType<typeof this.processMessage> = {};

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id) {
          result.sessionId = msg.session_id;
        }
        break;

      case "assistant":
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              result.text = block.text;
            } else if (block.type === "tool_use" && block.name) {
              result.toolUse = { name: block.name, input: block.input };

              // Check for AskUserQuestion
              if (block.name === "AskUserQuestion" && block.input) {
                const input = block.input as {
                  questions?: Question[];
                  answers?: Record<string, string>;
                };

                if (input.questions && !input.answers) {
                  result.pendingQuestion = {
                    questions: input.questions,
                    context: "", // Will be filled from accumulated output
                  };
                }
              }
            }
          }
        }
        break;

      case "result":
        result.costUsd = msg.total_cost_usd || 0;
        result.turns = msg.num_turns || 0;
        result.success = msg.subtype === "success";
        if (msg.subtype !== "success" && msg.errors) {
          result.error = msg.errors.join("; ");
        }
        break;
    }

    return result;
  }

  /**
   * Abort all running agents
   * Kills all spawned claude processes immediately
   */
  abort(): void {
    for (const proc of this.runningProcesses) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
    }
    this.runningProcesses.clear();
  }
}

/**
 * Create a CLI agent runner instance
 */
export function createCLIAgentRunner(): AgentRunner {
  return new CLIAgentRunner();
}
