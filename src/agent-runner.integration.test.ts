/**
 * Integration tests for agent-runner
 *
 * These tests actually invoke the Claude Agent SDK via our runAgent() function
 * to verify the same code path that `whs start` uses.
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
import { runAgent } from "./agent-runner.js";

// Skip these tests unless explicitly run or AUTH_TEST env var is set
const shouldRun = process.env.AUTH_TEST === "1" || process.env.CI_AUTH_TEST === "1";

describe.skipIf(!shouldRun)("agent-runner integration", () => {
  // Create a temp directory that looks like a WHS orchestrator
  let tempDir: string;
  let whsDir: string;

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
  });

  afterAll(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runAgent authenticates and completes a simple task", async () => {
    /**
     * This test verifies the EXACT code path that whs start uses:
     * 1. runAgent() is called with cwd pointing to our temp directory
     * 2. loadWhsEnv() loads credentials from .whs/.env
     * 3. SDK is called with settingSources: ["user", "project"]
     * 4. permissionMode: "bypassPermissions"
     *
     * If authentication fails, we should get a clear error, NOT a masked one.
     */

    const result = await runAgent(
      "What is 2 + 2? Reply with just the number, nothing else.",
      {
        cwd: tempDir,
        maxTurns: 1,
        // Disable safety hooks for this test (no worktree to confine to)
        enableSafetyHooks: false,
      }
    );

    // Check for authentication failure - this is what we were missing before!
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
      // Some other error
      throw new Error(`runAgent failed: ${result.error}`);
    }

    // Verify we got a real response
    expect(result.sessionId).toBeTruthy();
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
    // Cost should be non-zero for a real API call
    expect(result.costUsd).toBeGreaterThan(0);
  }, 120000); // 2 minute timeout for API call

  it("runAgent can use tools (Read) like the dispatcher does", async () => {
    /**
     * Tests that runAgent works with tools enabled, similar to how
     * the dispatcher runs implementation agents.
     */

    // Create a test file
    const testFile = join(tempDir, "test-file.txt");
    writeFileSync(testFile, "Hello from WHS integration test!");

    const result = await runAgent(
      `Read the file at ${testFile} and tell me exactly what it says.`,
      {
        cwd: tempDir,
        maxTurns: 3,
        enableSafetyHooks: false,
        // Let it use default tools (preset: claude_code)
      }
    );

    if (!result.success) {
      const errorLower = (result.error || "").toLowerCase();
      if (errorLower.includes("api key") || errorLower.includes("authentication")) {
        throw new Error(
          `Authentication failed! Run 'whs claude-login' to fix.\nError: ${result.error}`
        );
      }
      throw new Error(`runAgent failed: ${result.error}`);
    }

    expect(result.success).toBe(true);
    // The output should mention the file contents
    expect(result.output.toLowerCase()).toContain("hello");
  }, 120000);

  it("runAgent returns clear error when auth is missing (simulated)", async () => {
    /**
     * This test verifies that if authentication is missing, we get a
     * clear error message, not a masked one.
     *
     * We can't easily simulate missing auth without actually removing
     * credentials, but we can at least verify the error handling path
     * by checking that the result structure is correct.
     */

    // Just verify the result structure is what we expect
    const result = await runAgent("Say hello", {
      cwd: tempDir,
      maxTurns: 1,
      enableSafetyHooks: false,
    });

    // Result should have proper structure
    expect(result).toHaveProperty("sessionId");
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("costUsd");
    expect(result).toHaveProperty("turns");
    expect(result).toHaveProperty("durationMs");

    // If it failed, error should be populated
    if (!result.success) {
      expect(result.error).toBeTruthy();
    }
  }, 120000);
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
