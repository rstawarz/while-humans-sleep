/**
 * Mock Agent for WHS Integration Tests
 *
 * Provides a mock implementation of the Claude Agent SDK's query function
 * that can be configured to return scripted responses.
 */

import { vi } from "vitest";
import type { Handoff, Question } from "../../../src/types.js";

/**
 * Scripted agent response
 */
export interface ScriptedResponse {
  /** Match function to determine if this response applies */
  match: (prompt: string, agent?: string) => boolean;
  /** Text output from the agent */
  output?: string;
  /** Handoff to produce */
  handoff?: Handoff;
  /** Question to ask (causes agent to pause) */
  question?: {
    questions: Question[];
    context?: string;
  };
  /** Cost in USD */
  costUsd?: number;
  /** Whether the agent should fail */
  error?: string;
}

/**
 * Default response when no scripts match
 */
const DEFAULT_RESPONSE: ScriptedResponse = {
  match: () => true,
  output: "Task completed.",
  handoff: {
    next_agent: "DONE",
    context: "Task completed successfully.",
  },
  costUsd: 0.01,
};

/**
 * Mock agent state
 */
interface MockAgentState {
  scripts: ScriptedResponse[];
  sessionCounter: number;
  sessions: Map<string, { lastPrompt: string; lastAgent?: string }>;
}

const state: MockAgentState = {
  scripts: [],
  sessionCounter: 0,
  sessions: new Map(),
};

/**
 * Configures the mock agent with scripted responses.
 * Responses are checked in order; first match wins.
 */
export function configureMockAgent(scripts: ScriptedResponse[]): void {
  state.scripts = scripts;
}

/**
 * Resets the mock agent to default state
 */
export function resetMockAgent(): void {
  state.scripts = [];
  state.sessionCounter = 0;
  state.sessions.clear();
}

/**
 * Gets the matching response for a prompt
 */
function getMatchingResponse(prompt: string, agent?: string): ScriptedResponse {
  for (const script of state.scripts) {
    if (script.match(prompt, agent)) {
      return script;
    }
  }
  return DEFAULT_RESPONSE;
}

/**
 * Formats a handoff as YAML for agent output
 */
function formatHandoffYaml(handoff: Handoff): string {
  const lines = ["```yaml"];
  lines.push(`next_agent: ${handoff.next_agent}`);
  if (handoff.pr_number !== undefined) {
    lines.push(`pr_number: ${handoff.pr_number}`);
  }
  if (handoff.ci_status) {
    lines.push(`ci_status: ${handoff.ci_status}`);
  }
  lines.push(`context: |`);
  lines.push(`  ${handoff.context.replace(/\n/g, "\n  ")}`);
  lines.push("```");
  return lines.join("\n");
}

/**
 * Mock implementation of runAgent from agent-runner.ts
 */
export async function mockRunAgent(
  prompt: string,
  options: {
    cwd: string;
    maxTurns?: number;
    resume?: string;
    onOutput?: (text: string) => void;
    onToolUse?: (toolName: string, input: unknown) => void;
  }
): Promise<{
  sessionId: string;
  output: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  pendingQuestion?: {
    questions: Question[];
    context: string;
  };
}> {
  // Generate or reuse session ID
  let sessionId = options.resume;
  let agent: string | undefined;

  if (!sessionId) {
    state.sessionCounter++;
    sessionId = `mock-session-${state.sessionCounter}`;
  } else {
    // Get agent from previous session if resuming
    const prevSession = state.sessions.get(sessionId);
    agent = prevSession?.lastAgent;
  }

  // Extract agent name from prompt if present
  if (!agent) {
    const agentMatch = prompt.match(/agent:(\w+)/i);
    agent = agentMatch?.[1];
  }

  // Store session info
  state.sessions.set(sessionId, { lastPrompt: prompt, lastAgent: agent });

  // Find matching response
  const response = getMatchingResponse(prompt, agent);

  // Simulate delay
  await new Promise((r) => setTimeout(r, 10));

  // Handle error case
  if (response.error) {
    return {
      sessionId,
      output: "",
      costUsd: response.costUsd || 0,
      turns: 1,
      durationMs: 10,
      success: false,
      error: response.error,
    };
  }

  // Handle question case
  if (response.question) {
    return {
      sessionId,
      output: response.output || "I have a question for you.",
      costUsd: response.costUsd || 0.01,
      turns: 1,
      durationMs: 10,
      success: true,
      pendingQuestion: {
        questions: response.question.questions,
        context: response.question.context || response.output || "",
      },
    };
  }

  // Build output
  let output = response.output || "Done.";
  if (response.handoff) {
    output += "\n\n" + formatHandoffYaml(response.handoff);
  }

  // Call output callback
  if (options.onOutput) {
    options.onOutput(output);
  }

  return {
    sessionId,
    output,
    costUsd: response.costUsd || 0.01,
    turns: 1,
    durationMs: 10,
    success: true,
  };
}

/**
 * Creates a vi.mock setup for the agent-runner module
 */
export function createAgentRunnerMock() {
  return {
    runAgent: vi.fn(mockRunAgent),
    resumeWithAnswer: vi.fn(
      (sessionId: string, answer: string, options: { cwd: string; maxTurns?: number }) =>
        mockRunAgent(answer, { ...options, resume: sessionId })
    ),
    formatAgentPrompt: vi.fn(
      (params: {
        taskTitle: string;
        taskDescription: string;
        workflowContext?: string;
        agentRole: string;
      }) => `# Task: ${params.taskTitle}\n\n${params.taskDescription}`
    ),
  };
}

/**
 * Helper to create a simple response script
 */
export function simpleResponse(
  matchFn: (prompt: string, agent?: string) => boolean,
  handoff: Handoff
): ScriptedResponse {
  return {
    match: matchFn,
    output: `Completed ${handoff.context.split("\n")[0]}`,
    handoff,
  };
}

/**
 * Helper to create a response that asks a question
 */
export function questionResponse(
  matchFn: (prompt: string, agent?: string) => boolean,
  questions: Question[],
  context?: string
): ScriptedResponse {
  return {
    match: matchFn,
    output: context || "I need some information.",
    question: { questions, context },
  };
}

/**
 * Helper to create a response that errors
 */
export function errorResponse(
  matchFn: (prompt: string, agent?: string) => boolean,
  errorMessage: string
): ScriptedResponse {
  return {
    match: matchFn,
    error: errorMessage,
  };
}

/**
 * Helper to create a response for a specific agent
 */
export function agentResponse(agent: string, handoff: Handoff): ScriptedResponse {
  return {
    match: (_prompt: string, matchAgent?: string) =>
      matchAgent === agent || _prompt.toLowerCase().includes(agent.toLowerCase()),
    output: `Completed ${agent} work. ${handoff.context.split("\n")[0]}`,
    handoff,
    costUsd: 0.05,
  };
}

/**
 * Configuration for a workflow step in a script
 */
export interface WorkflowScriptStep {
  agent: string;
  handoff: Handoff;
  question?: {
    questions: Question[];
    context?: string;
  };
  error?: string;
}

/**
 * Creates a sequence of scripted responses for a complete workflow
 *
 * Each step matches based on the agent name and produces the configured handoff.
 * Steps are matched in order, allowing for the same agent to appear multiple times.
 */
export function workflowScript(steps: WorkflowScriptStep[]): ScriptedResponse[] {
  const usedSteps = new Set<number>();

  return steps.map((step, index) => ({
    match: (_prompt: string, agent?: string) => {
      // Check if this step hasn't been used and matches the agent
      if (usedSteps.has(index)) return false;

      const agentMatches =
        agent === step.agent ||
        _prompt.toLowerCase().includes(step.agent.toLowerCase());

      if (agentMatches) {
        usedSteps.add(index);
        return true;
      }
      return false;
    },
    output: step.question
      ? `I need some information for ${step.agent}.`
      : `Completed ${step.agent} work. ${step.handoff.context.split("\n")[0]}`,
    handoff: step.question ? undefined : step.handoff,
    question: step.question,
    error: step.error,
    costUsd: 0.05,
  }));
}

/**
 * Gets the number of times the mock agent has been invoked
 */
export function getInvocationCount(): number {
  return state.sessionCounter;
}

/**
 * Gets all sessions that have been created
 */
export function getSessions(): Map<string, { lastPrompt: string; lastAgent?: string }> {
  return new Map(state.sessions);
}
