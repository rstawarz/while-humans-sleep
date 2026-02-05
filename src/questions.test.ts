import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatQuestionForDisplay } from "./questions.js";
import type { FormattedQuestion } from "./questions.js";

describe("questions service", () => {
  describe("formatQuestionForDisplay", () => {
    it("formats a question with all fields", () => {
      const question: FormattedQuestion = {
        beadId: "orc-abc.1",
        project: "bread_and_butter",
        stepId: "orc-abc.1",
        epicId: "orc-abc",
        createdAt: new Date(Date.now() - 2 * 60 * 1000), // 2 minutes ago
        context: "I'm implementing the auth service.",
        questions: [
          {
            question: "Which authentication method should we use?",
            header: "Auth",
            options: [
              { label: "JWT", description: "Stateless tokens" },
              { label: "Sessions", description: "Server-side sessions" },
            ],
            multiSelect: false,
          },
        ],
        sessionId: "session-123",
        worktree: "/tmp/worktree",
      };

      const output = formatQuestionForDisplay(question);

      expect(output).toContain("Question from bread_and_butter (orc-abc.1)");
      expect(output).toContain("Step: 1");
      expect(output).toContain("2 minutes ago");
      expect(output).toContain("I'm implementing the auth service.");
      expect(output).toContain("Q: Which authentication method should we use?");
      expect(output).toContain("1. JWT (Stateless tokens)");
      expect(output).toContain("2. Sessions (Server-side sessions)");
    });

    it("formats time as just now for recent questions", () => {
      const question: FormattedQuestion = {
        beadId: "orc-xyz.1",
        project: "myproject",
        stepId: "orc-xyz.1",
        epicId: "orc-xyz",
        createdAt: new Date(Date.now() - 30 * 1000), // 30 seconds ago
        context: "",
        questions: [
          {
            question: "What color?",
            header: "Color",
            options: [{ label: "Red" }, { label: "Blue" }],
            multiSelect: false,
          },
        ],
        sessionId: "session-456",
        worktree: "/tmp/worktree2",
      };

      const output = formatQuestionForDisplay(question);

      expect(output).toContain("just now");
    });

    it("handles questions without options", () => {
      const question: FormattedQuestion = {
        beadId: "orc-123.1",
        project: "myproject",
        stepId: "orc-123.1",
        epicId: "orc-123",
        createdAt: new Date(),
        context: "Some context here.",
        questions: [
          {
            question: "Please enter a name:",
            header: "Name",
            options: [],
            multiSelect: false,
          },
        ],
        sessionId: "session-789",
        worktree: "/tmp/worktree3",
      };

      const output = formatQuestionForDisplay(question);

      expect(output).toContain("Q: Please enter a name:");
      expect(output).not.toContain("1.");
      expect(output).not.toContain("2.");
    });

    it("truncates long context to 5 lines", () => {
      const longContext = Array(10)
        .fill(null)
        .map((_, i) => `Line ${i + 1} of context`)
        .join("\n");

      const question: FormattedQuestion = {
        beadId: "orc-long.1",
        project: "myproject",
        stepId: "orc-long.1",
        epicId: "orc-long",
        createdAt: new Date(),
        context: longContext,
        questions: [
          {
            question: "What next?",
            header: "Next",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: false,
          },
        ],
        sessionId: "session-abc",
        worktree: "/tmp/worktree4",
      };

      const output = formatQuestionForDisplay(question);

      expect(output).toContain("Line 1 of context");
      expect(output).toContain("Line 5 of context");
      expect(output).toContain("...");
      expect(output).not.toContain("Line 6 of context");
    });

    it("formats hours ago correctly", () => {
      const question: FormattedQuestion = {
        beadId: "orc-hours.1",
        project: "myproject",
        stepId: "orc-hours.1",
        epicId: "orc-hours",
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3 hours ago
        context: "",
        questions: [
          {
            question: "Test?",
            header: "Test",
            options: [{ label: "Yes" }, { label: "No" }],
            multiSelect: false,
          },
        ],
        sessionId: "session-def",
        worktree: "/tmp/worktree5",
      };

      const output = formatQuestionForDisplay(question);

      expect(output).toContain("3 hours ago");
    });

    it("formats days ago correctly", () => {
      const question: FormattedQuestion = {
        beadId: "orc-days.1",
        project: "myproject",
        stepId: "orc-days.1",
        epicId: "orc-days",
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
        context: "",
        questions: [
          {
            question: "Test?",
            header: "Test",
            options: [{ label: "Yes" }, { label: "No" }],
            multiSelect: false,
          },
        ],
        sessionId: "session-ghi",
        worktree: "/tmp/worktree6",
      };

      const output = formatQuestionForDisplay(question);

      expect(output).toContain("2 days ago");
    });
  });
});
