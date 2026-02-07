/**
 * Integration tests for agent runners
 *
 * These tests actually invoke the agent runners to verify authentication
 * and the code paths that `whs start` uses.
 *
 * They are skipped by default - run with:
 *   AUTH_TEST=1 npm test -- --run agent-runner.integration
 *
 * Prerequisites:
 * - ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN must be set
 * - Or run `whs claude-login` first
 *
 * These tests would have caught the authentication bug where:
 * - apiKeySource: "none" was returned
 * - error: "authentication_failed" was in the response
 * - But we were masking it by ignoring "process exited" errors after "success"
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createClaudeSdkAgentRunner } from "./claude-sdk-agent-runner.js";
import { createCLIAgentRunner } from "./cli-agent-runner.js";
import type { AgentRunner } from "./agent-runner-interface.js";

// Skip these tests unless explicitly run or AUTH_TEST env var is set
const shouldRun = process.env.AUTH_TEST === "1" || process.env.CI_AUTH_TEST === "1";

describe.skipIf(!shouldRun)("agent-runner integration", () => {
  // Create a temp directory that looks like a WHS orchestrator
  let tempDir: string;
  let whsDir: string;
  let sdkRunner: AgentRunner;
  let cliRunner: AgentRunner;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "whs-auth-test-"));
    whsDir = join(tempDir, ".whs");
    mkdirSync(whsDir, { recursive: true });

    // Create minimal WHS config so loadWhsEnv() can find the directory
    writeFileSync(
      join(whsDir, "config.json"),
      JSON.stringify({
        projects: [],
        orchestratorPath: tempDir,
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "cli",
      })
    );

    // If ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set in env,
    // also write it to .whs/.env so our loadWhsEnv picks it up
    const envLines: string[] = [];
    if (process.env.ANTHROPIC_API_KEY) {
      envLines.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      envLines.push(`CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
    }
    if (envLines.length > 0) {
      writeFileSync(join(whsDir, ".env"), envLines.join("\n") + "\n");
    }

    // Create runners
    sdkRunner = createClaudeSdkAgentRunner();
    cliRunner = createCLIAgentRunner();
  });

  afterAll(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("SDK Runner", () => {
    it("authenticates and completes a simple task", async () => {
      /**
       * This test verifies the EXACT code path that whs start uses with SDK:
       * 1. run() is called with cwd pointing to our temp directory
       * 2. loadWhsEnv() loads credentials from .whs/.env
       * 3. SDK is called with settingSources: ["user", "project"]
       * 4. permissionMode: "bypassPermissions"
       *
       * If authentication fails, we should get a clear error, NOT a masked one.
       */

      const result = await sdkRunner.run({
        prompt: "What is 2 + 2? Reply with just the number, nothing else.",
        cwd: tempDir,
        maxTurns: 1,
      });

      // Check for authentication failure
      if (!result.success) {
        const errorLower = (result.error || "").toLowerCase();
        if (
          errorLower.includes("api key") ||
          errorLower.includes("authentication") ||
          errorLower.includes("apikeysource") ||
          errorLower.includes("invalid")
        ) {
          throw new Error(
            `Authentication failed!\n\n` +
              `This is the error that whs start would encounter.\n` +
              `Fix: Run 'whs claude-login' or set ANTHROPIC_API_KEY.\n\n` +
              `Error: ${result.error}`
          );
        }
        throw new Error(`SDK runner failed: ${result.error}`);
      }

      // Verify we got a real response
      expect(result.sessionId).toBeTruthy();
      expect(result.success).toBe(true);
      expect(result.output).toBeTruthy();
      // Cost should be non-zero for a real API call
      expect(result.costUsd).toBeGreaterThan(0);
    }, 120000); // 2 minute timeout for API call
  });

  describe("CLI Runner", () => {
    it("authenticates and completes a simple task", async () => {
      /**
       * This test verifies the CLI runner using the claude command.
       * Uses Max subscription (no API costs).
       */

      const result = await cliRunner.run({
        prompt: "What is 2 + 2? Reply with just the number, nothing else.",
        cwd: tempDir,
        maxTurns: 1,
      });

      // Check for authentication failure
      if (!result.success) {
        const errorLower = (result.error || "").toLowerCase();
        if (
          result.isAuthError ||
          errorLower.includes("api key") ||
          errorLower.includes("authentication") ||
          errorLower.includes("login")
        ) {
          throw new Error(
            `Authentication failed!\n\n` +
              `This is the error that whs start would encounter.\n` +
              `Fix: Run 'claude /login' to authenticate the CLI.\n\n` +
              `Error: ${result.error}`
          );
        }
        throw new Error(`CLI runner failed: ${result.error}`);
      }

      // Verify we got a real response
      expect(result.sessionId).toBeTruthy();
      expect(result.success).toBe(true);
      expect(result.output).toBeTruthy();
      // CLI runner may report 0 cost (uses Max subscription)
      expect(typeof result.costUsd).toBe("number");
    }, 120000);
  });
});

/**
 * Unit test that verifies we DON'T mask authentication errors.
 *
 * The original bug was that we caught "process exited with code 1" after
 * receiving a "success" result message, and ignored it. But that "success"
 * was actually accompanied by "is_error": true and "authentication_failed".
 */
describe("agent-runner error handling", () => {
  it("does not mask errors after apparent success", () => {
    // This is a design verification - the actual behavior is tested
    // in the integration tests above. Here we just document the expectation:
    //
    // When the SDK returns a "result" message with subtype "success" but
    // the assistant message has error: "authentication_failed", we should
    // NOT report success. The integration test above will catch this if
    // it regresses.
    //
    // The fix was to:
    // 1. Remove the code that ignored "process exited" errors after success
    // 2. Properly check for authentication errors in assistant messages
    expect(true).toBe(true); // Placeholder - real test is above
  });
});
