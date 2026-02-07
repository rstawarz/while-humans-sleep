/**
 * Agent Runner Factory
 *
 * Creates the appropriate agent runner based on configuration.
 */

import type { AgentRunner, AgentRunnerType } from "./agent-runner-interface.js";
import { createCLIAgentRunner } from "./cli-agent-runner.js";
import { createClaudeSdkAgentRunner } from "./claude-sdk-agent-runner.js";

/**
 * Create an agent runner of the specified type
 *
 * @param type - "cli" for Max subscription (no API costs), "sdk" for API-based (pay-per-token)
 * @returns An AgentRunner instance
 */
export function createAgentRunner(type: AgentRunnerType = "cli"): AgentRunner {
  switch (type) {
    case "cli":
      return createCLIAgentRunner();
    case "sdk":
      return createClaudeSdkAgentRunner();
    default:
      throw new Error(`Unknown agent runner type: ${type}`);
  }
}
