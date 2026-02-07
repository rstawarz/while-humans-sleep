/**
 * Claude SDK Agent Runner
 *
 * Runs agents via the Claude Agent SDK (requires API key, pay-per-token).
 * For Max subscription usage, see cli-agent-runner.ts instead.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
} from "./agent-runner-interface.js";
import type { Question } from "./types.js";
import { recordStepComplete } from "./metrics.js";
import { loadWhsEnv } from "./config.js";
import {
  createBashSafetyHook,
  createFileSafetyHook,
  isAuthenticationError,
} from "./agent-runner.js";

/**
 * SDK-based agent runner
 *
 * Uses the Claude Agent SDK which requires an API key and charges per token.
 */
export class ClaudeSdkAgentRunner implements AgentRunner {
  /** Abort flag - set to true to stop running agents */
  private aborted = false;

  /**
   * Run an agent with the given prompt
   */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    return this.executeAgent(options.prompt, options);
  }

  /**
   * Resume a session with an answer
   */
  async resumeWithAnswer(
    sessionId: string,
    answer: string,
    options: Omit<AgentRunOptions, "prompt" | "resume">
  ): Promise<AgentRunResult> {
    return this.executeAgent(answer, {
      ...options,
      prompt: answer,
      resume: sessionId,
    });
  }

  /**
   * Execute the agent via SDK
   */
  private async executeAgent(
    prompt: string,
    options: AgentRunOptions
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
      // Build hooks for safety
      const hooks = this.buildHooks(options.cwd);

      // Load environment with WHS credentials
      const env = loadWhsEnv();

      const queryOptions: Parameters<typeof query>[0]["options"] = {
        cwd: options.cwd,
        env,
        settingSources: ["user", "project"],
        systemPrompt: options.systemPrompt
          ? { type: "preset", preset: "claude_code", append: options.systemPrompt }
          : { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: options.allowedTools,
        maxTurns: options.maxTurns ?? 50,
        resume: options.resume,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        hooks,
      };

      // Stream messages from the agent
      for await (const message of query({ prompt, options: queryOptions })) {
        // Check for abort
        if (this.aborted) {
          success = false;
          error = "Agent aborted by dispatcher shutdown";
          break;
        }

        switch (message.type) {
          case "system":
            if (message.subtype === "init") {
              sessionId = message.session_id;
            }
            break;

          case "assistant":
            if (message.error) {
              success = false;
              error = `SDK error: ${message.error}`;
            }

            if (message.message?.content) {
              for (const block of message.message.content) {
                if ("text" in block && block.text) {
                  output += block.text + "\n";
                  options.onOutput?.(block.text);
                } else if ("name" in block) {
                  const toolName = block.name;
                  const toolInput = "input" in block ? block.input : undefined;
                  options.onToolUse?.(toolName, toolInput);

                  // Check for AskUserQuestion tool
                  if (toolName === "AskUserQuestion" && toolInput) {
                    const input = toolInput as {
                      questions?: Question[];
                      answers?: Record<string, string>;
                    };

                    if (input.questions && !input.answers) {
                      pendingQuestion = {
                        questions: input.questions,
                        context: output.slice(-500),
                      };
                    }
                  }
                }
              }
            }
            break;

          case "result":
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
      const errMessage = err instanceof Error ? err.message : String(err);
      success = false;
      error = errMessage;
    }

    // Record metrics if context provided
    if (options.metricsContext?.stepId && !pendingQuestion) {
      try {
        const outcome = success ? "success" : (error || "unknown_error");
        recordStepComplete(options.metricsContext.stepId, costUsd, outcome, turns, options.maxTurns);
      } catch {
        console.warn("Failed to record step metrics");
      }
    }

    const isAuthError = isAuthenticationError(output) || (error ? isAuthenticationError(error) : false);

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
   * Build hooks configuration for SDK
   */
  private buildHooks(worktreePath: string): Record<string, unknown> {
    const bashHook = createBashSafetyHook(worktreePath);
    const fileHook = createFileSafetyHook(worktreePath);

    return {
      PreToolUse: [
        {
          matcher: /^Bash$/,
          hooks: [
            async ({ toolInput }: { toolInput: { command?: string } }) => {
              if (!toolInput.command) return {};
              return bashHook({ command: toolInput.command });
            },
          ],
        },
        {
          matcher: /^Write$/,
          hooks: [
            async ({ toolInput }: { toolInput: { file_path?: string } }) => {
              return fileHook(toolInput);
            },
          ],
        },
        {
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
   * Abort all running agents
   * Sets abort flag - agents will stop at next message processing
   * Note: SDK doesn't support true cancellation, so this is best-effort
   */
  abort(): void {
    this.aborted = true;
  }
}

/**
 * Create a Claude SDK agent runner instance
 */
export function createClaudeSdkAgentRunner(): AgentRunner {
  return new ClaudeSdkAgentRunner();
}
