import { describe, it, expect } from "vitest";
import {
  tryParseHandoff,
  isValidAgent,
  formatHandoff,
  VALID_AGENTS,
} from "./handoff.js";

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

describe("getHandoff integration", () => {
  // These tests require the SDK and would incur costs
  // Document expected behavior

  it.skip("falls back to forceHandoffViaTool when parsing fails", async () => {
    // Would need to mock SDK
  });

  it.skip("returns BLOCKED fallback when all methods fail", async () => {
    // Would need to mock SDK
  });
});
