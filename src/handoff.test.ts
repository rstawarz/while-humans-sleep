import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  tryParseHandoff,
  isValidAgent,
  formatHandoff,
  VALID_AGENTS,
  readHandoffFile,
  writeHandoffFile,
  cleanHandoffFile,
  getHandoff,
  HANDOFF_FILENAME,
} from "./handoff.js";
import type { AgentRunner } from "./agent-runner-interface.js";

describe("isValidAgent", () => {
  it("returns true for valid agents", () => {
    for (const agent of VALID_AGENTS) {
      expect(isValidAgent(agent)).toBe(true);
    }
  });

  it("returns false for invalid agents", () => {
    expect(isValidAgent("invalid")).toBe(false);
    expect(isValidAgent("")).toBe(false);
    expect(isValidAgent("Implementation")).toBe(false); // case sensitive
  });
});

describe("tryParseHandoff", () => {
  describe("YAML code block parsing", () => {
    it("parses standard YAML block", () => {
      const output = `
Done with the implementation.

\`\`\`yaml
next_agent: quality_review
pr_number: 42
ci_status: pending
context: |
  Created PR with auth changes.
  Tests passing locally.
\`\`\`
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff).not.toBeNull();
      expect(handoff?.next_agent).toBe("quality_review");
      expect(handoff?.pr_number).toBe(42);
      expect(handoff?.ci_status).toBe("pending");
      expect(handoff?.context).toContain("Created PR");
    });

    it("parses yml block (alternative extension)", () => {
      const output = `
\`\`\`yml
next_agent: implementation
context: Need to fix the bug
\`\`\`
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.next_agent).toBe("implementation");
    });

    it("handles DONE agent", () => {
      const output = `
\`\`\`yaml
next_agent: DONE
context: Task completed successfully
\`\`\`
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.next_agent).toBe("DONE");
    });

    it("handles BLOCKED agent", () => {
      const output = `
\`\`\`yaml
next_agent: BLOCKED
context: Need human input on design decision
\`\`\`
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.next_agent).toBe("BLOCKED");
    });
  });

  describe("JSON code block parsing", () => {
    it("parses JSON block", () => {
      const output = `
\`\`\`json
{
  "next_agent": "release_manager",
  "pr_number": 123,
  "context": "PR approved, ready to merge"
}
\`\`\`
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.next_agent).toBe("release_manager");
      expect(handoff?.pr_number).toBe(123);
    });

    it("handles camelCase keys in JSON", () => {
      const output = `
\`\`\`json
{
  "nextAgent": "quality_review",
  "prNumber": 45,
  "ciStatus": "passed",
  "context": "Ready for review"
}
\`\`\`
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.next_agent).toBe("quality_review");
      expect(handoff?.pr_number).toBe(45);
      expect(handoff?.ci_status).toBe("passed");
    });
  });

  describe("inline YAML parsing", () => {
    it("parses inline YAML without code block", () => {
      const output = `
I've completed the work. Here's the handoff:

next_agent: quality_review
pr_number: 50
context: PR ready for review
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.next_agent).toBe("quality_review");
    });

    it("extracts handoff from longer output", () => {
      const output = `
I analyzed the code and made the following changes:
- Added authentication middleware
- Updated user routes
- Added tests

next_agent: quality_review
context: Implementation complete, tests passing
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.next_agent).toBe("quality_review");
      expect(handoff?.context).toContain("Implementation complete");
    });
  });

  describe("edge cases", () => {
    it("returns null for empty output", () => {
      expect(tryParseHandoff("")).toBeNull();
    });

    it("returns null for output without handoff", () => {
      const output = "I made some changes to the code. Let me know if you have questions.";
      expect(tryParseHandoff(output)).toBeNull();
    });

    it("returns null for invalid agent name", () => {
      const output = `
\`\`\`yaml
next_agent: invalid_agent
context: This should fail
\`\`\`
      `;

      expect(tryParseHandoff(output)).toBeNull();
    });

    it("returns null for missing required fields", () => {
      const output = `
\`\`\`yaml
next_agent: quality_review
\`\`\`
      `;

      // Missing context
      expect(tryParseHandoff(output)).toBeNull();
    });

    it("handles pr_number as string", () => {
      const output = `
\`\`\`yaml
next_agent: quality_review
pr_number: "42"
context: Test
\`\`\`
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.pr_number).toBe(42);
    });

    it("prefers first valid handoff in output", () => {
      const output = `
\`\`\`yaml
next_agent: implementation
context: First handoff
\`\`\`

Wait, let me reconsider:

\`\`\`yaml
next_agent: quality_review
context: Second handoff
\`\`\`
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.next_agent).toBe("implementation");
    });
  });

  describe("multiline context", () => {
    it("parses multiline context with pipe", () => {
      const output = `
\`\`\`yaml
next_agent: quality_review
context: |
  Line 1
  Line 2
  Line 3
\`\`\`
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.context).toContain("Line 1");
      expect(handoff?.context).toContain("Line 2");
    });

    it("parses multiline context with >", () => {
      const output = `
\`\`\`yaml
next_agent: quality_review
context: >
  This is a folded
  multiline string
\`\`\`
      `;

      const handoff = tryParseHandoff(output);
      expect(handoff?.context).toBeTruthy();
    });
  });
});

describe("formatHandoff", () => {
  it("formats a simple handoff", () => {
    const handoff = {
      next_agent: "quality_review",
      context: "Ready for review",
    };

    const formatted = formatHandoff(handoff);
    expect(formatted).toContain("next_agent: quality_review");
    expect(formatted).toContain("context: Ready for review");
  });

  it("includes optional fields when present", () => {
    const handoff = {
      next_agent: "release_manager",
      pr_number: 42,
      ci_status: "passed" as const,
      context: "PR approved",
    };

    const formatted = formatHandoff(handoff);
    expect(formatted).toContain("pr_number: 42");
    expect(formatted).toContain("ci_status: passed");
  });

  it("handles multiline context", () => {
    const handoff = {
      next_agent: "quality_review",
      context: "Line 1\nLine 2\nLine 3",
    };

    const formatted = formatHandoff(handoff);
    expect(formatted).toContain("context: |");
    expect(formatted).toContain("  Line 1");
    expect(formatted).toContain("  Line 2");
  });
});

describe("file-based handoff", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `whs-handoff-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("writeHandoffFile", () => {
    it("writes valid JSON handoff file", () => {
      const handoff = {
        next_agent: "quality_review",
        context: "PR ready for review",
        pr_number: 42,
      };

      writeHandoffFile(testDir, handoff);

      const filePath = join(testDir, HANDOFF_FILENAME);
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(content.next_agent).toBe("quality_review");
      expect(content.context).toBe("PR ready for review");
      expect(content.pr_number).toBe(42);
    });

    it("writes all optional fields", () => {
      const handoff = {
        next_agent: "release_manager",
        context: "PR approved",
        pr_number: 99,
        ci_status: "passed" as const,
      };

      writeHandoffFile(testDir, handoff);

      const content = JSON.parse(readFileSync(join(testDir, HANDOFF_FILENAME), "utf-8"));
      expect(content.ci_status).toBe("passed");
    });
  });

  describe("readHandoffFile", () => {
    it("reads a valid handoff file", () => {
      const handoff = {
        next_agent: "quality_review",
        context: "PR ready",
      };
      writeHandoffFile(testDir, handoff);

      const result = readHandoffFile(testDir);
      expect(result).not.toBeNull();
      expect(result?.next_agent).toBe("quality_review");
      expect(result?.context).toBe("PR ready");
    });

    it("returns null when file does not exist", () => {
      const result = readHandoffFile(testDir);
      expect(result).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      const filePath = join(testDir, HANDOFF_FILENAME);
      const { writeFileSync } = require("fs");
      writeFileSync(filePath, "not json");

      const result = readHandoffFile(testDir);
      expect(result).toBeNull();
    });

    it("returns null for valid JSON with invalid handoff data", () => {
      const filePath = join(testDir, HANDOFF_FILENAME);
      const { writeFileSync } = require("fs");
      writeFileSync(filePath, JSON.stringify({ foo: "bar" }));

      const result = readHandoffFile(testDir);
      expect(result).toBeNull();
    });
  });

  describe("cleanHandoffFile", () => {
    it("removes the handoff file", () => {
      writeHandoffFile(testDir, { next_agent: "DONE", context: "Done" });
      expect(existsSync(join(testDir, HANDOFF_FILENAME))).toBe(true);

      cleanHandoffFile(testDir);
      expect(existsSync(join(testDir, HANDOFF_FILENAME))).toBe(false);
    });

    it("does not throw when file does not exist", () => {
      expect(() => cleanHandoffFile(testDir)).not.toThrow();
    });
  });
});

describe("getHandoff", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `whs-handoff-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns handoff from file when present (highest priority)", async () => {
    // Write a handoff file
    writeHandoffFile(testDir, {
      next_agent: "release_manager",
      context: "From file",
    });

    // Also provide output with a different handoff
    const output = "```yaml\nnext_agent: implementation\ncontext: From output\n```";

    const handoff = await getHandoff(output, "session-1", testDir);

    // File takes priority over output parsing
    expect(handoff.next_agent).toBe("release_manager");
    expect(handoff.context).toBe("From file");

    // File should be cleaned up
    expect(existsSync(join(testDir, HANDOFF_FILENAME))).toBe(false);
  });

  it("falls back to output parsing when no file", async () => {
    const output = "```yaml\nnext_agent: quality_review\ncontext: From output\n```";

    const handoff = await getHandoff(output, "session-1", testDir);
    expect(handoff.next_agent).toBe("quality_review");
    expect(handoff.context).toBe("From output");
  });

  it("resumes session via runner when file and output both fail", async () => {
    const mockRunner: AgentRunner = {
      run: vi.fn(),
      resumeWithAnswer: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        output: "```yaml\nnext_agent: DONE\ncontext: Forced via resume\n```",
        costUsd: 0.001,
        turns: 1,
        durationMs: 2000,
        success: true,
      }),
      abort: vi.fn(),
    };

    const handoff = await getHandoff(
      "no handoff here",
      "session-1",
      testDir,
      mockRunner
    );

    expect(handoff.next_agent).toBe("DONE");
    expect(handoff.context).toBe("Forced via resume");
    expect(mockRunner.resumeWithAnswer).toHaveBeenCalledWith(
      "session-1",
      expect.stringContaining("whs handoff"),
      expect.objectContaining({ cwd: testDir, maxTurns: 3 })
    );
  });

  it("checks for handoff file after resume (agent may have used whs handoff)", async () => {
    const mockRunner: AgentRunner = {
      run: vi.fn(),
      resumeWithAnswer: vi.fn().mockImplementation(async () => {
        // Simulate agent writing handoff file during resume
        writeHandoffFile(testDir, {
          next_agent: "quality_review",
          context: "Written by agent via whs handoff",
          pr_number: 77,
        });
        return {
          sessionId: "session-1",
          output: "I ran whs handoff",
          costUsd: 0.001,
          turns: 1,
          durationMs: 2000,
          success: true,
        };
      }),
      abort: vi.fn(),
    };

    const handoff = await getHandoff(
      "no handoff here",
      "session-1",
      testDir,
      mockRunner
    );

    // Should pick up the file written during resume
    expect(handoff.next_agent).toBe("quality_review");
    expect(handoff.context).toBe("Written by agent via whs handoff");
    expect(handoff.pr_number).toBe(77);
  });

  it("returns BLOCKED when all methods fail", async () => {
    const mockRunner: AgentRunner = {
      run: vi.fn(),
      resumeWithAnswer: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        output: "I dont know what to do",
        costUsd: 0.001,
        turns: 3,
        durationMs: 5000,
        success: true,
      }),
      abort: vi.fn(),
    };

    const handoff = await getHandoff(
      "no handoff here",
      "session-1",
      testDir,
      mockRunner
    );

    expect(handoff.next_agent).toBe("BLOCKED");
    expect(handoff.context).toContain("failed to produce");
  });

  it("returns BLOCKED when no runner provided and parsing fails", async () => {
    const handoff = await getHandoff("no handoff here", "session-1", testDir);
    expect(handoff.next_agent).toBe("BLOCKED");
  });

  it("returns BLOCKED when runner throws", async () => {
    const mockRunner: AgentRunner = {
      run: vi.fn(),
      resumeWithAnswer: vi.fn().mockRejectedValue(new Error("Session expired")),
      abort: vi.fn(),
    };

    const handoff = await getHandoff(
      "no handoff here",
      "session-1",
      testDir,
      mockRunner
    );

    expect(handoff.next_agent).toBe("BLOCKED");
  });
});
