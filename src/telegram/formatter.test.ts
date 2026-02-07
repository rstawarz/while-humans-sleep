/**
 * Tests for Telegram message formatter
 */

import { describe, it, expect } from "vitest";
import {
  escapeMarkdownV2,
  formatQuestionMessage,
  generateQuestionKeyboard,
  parseCallbackData,
} from "./formatter.js";
import type { QuestionBeadData } from "../types.js";

describe("escapeMarkdownV2", () => {
  it("escapes special characters", () => {
    expect(escapeMarkdownV2("Hello_World")).toBe("Hello\\_World");
    expect(escapeMarkdownV2("1 + 2 = 3")).toBe("1 \\+ 2 \\= 3");
    expect(escapeMarkdownV2("(foo) [bar]")).toBe("\\(foo\\) \\[bar\\]");
  });

  it("escapes multiple special characters", () => {
    expect(escapeMarkdownV2("**bold**")).toBe("\\*\\*bold\\*\\*");
    expect(escapeMarkdownV2("`code`")).toBe("\\`code\\`");
  });

  it("handles empty string", () => {
    expect(escapeMarkdownV2("")).toBe("");
  });

  it("handles string with no special characters", () => {
    expect(escapeMarkdownV2("Hello World")).toBe("Hello World");
  });
});

describe("formatQuestionMessage", () => {
  const baseQuestionData: QuestionBeadData = {
    metadata: {
      session_id: "sess-123",
      worktree: "/path/to/worktree",
      step_id: "orc-abc.1",
      epic_id: "orc-abc",
      project: "test-project",
      asked_at: "2024-01-15T10:00:00Z",
    },
    context: "Working on auth implementation",
    questions: [
      {
        question: "Which auth method should we use?",
        header: "Auth",
        options: [
          { label: "JWT", description: "Stateless tokens" },
          { label: "Sessions", description: "Server-side sessions" },
        ],
        multiSelect: false,
      },
    ],
  };

  it("formats question with project and step", () => {
    const { text } = formatQuestionMessage("q-123", baseQuestionData);

    expect(text).toContain("*Question from test\\-project*");
    expect(text).toContain("Step: `orc\\-abc\\.1`");
  });

  it("includes context when present", () => {
    const { text } = formatQuestionMessage("q-123", baseQuestionData);

    expect(text).toContain("_Context:_");
    expect(text).toContain("Working on auth implementation");
  });

  it("includes question text", () => {
    const { text } = formatQuestionMessage("q-123", baseQuestionData);

    // The question is wrapped in bold and escaped for MarkdownV2
    expect(text).toContain("*Q: Which auth method should we use?*");
  });

  it("lists options in message", () => {
    const { text } = formatQuestionMessage("q-123", baseQuestionData);

    expect(text).toContain("1\\. JWT");
    expect(text).toContain("2\\. Sessions");
  });
});

describe("generateQuestionKeyboard", () => {
  const questionData: QuestionBeadData = {
    metadata: {
      session_id: "sess-123",
      worktree: "/path/to/worktree",
      step_id: "orc-abc.1",
      epic_id: "orc-abc",
      project: "test-project",
      asked_at: "2024-01-15T10:00:00Z",
    },
    context: "",
    questions: [
      {
        question: "Choose one",
        header: "Choice",
        options: [
          { label: "Option A" },
          { label: "Option B" },
          { label: "Option C" },
        ],
        multiSelect: false,
      },
    ],
  };

  it("creates inline keyboard with buttons", () => {
    const keyboard = generateQuestionKeyboard("q-123", questionData);

    expect(keyboard.inline_keyboard).toHaveLength(2); // 3 options = 2 rows (2+1)
    expect(keyboard.inline_keyboard[0]).toHaveLength(2); // First row has 2 buttons
    expect(keyboard.inline_keyboard[1]).toHaveLength(1); // Second row has 1 button
  });

  it("includes option labels as button text", () => {
    const keyboard = generateQuestionKeyboard("q-123", questionData);

    expect(keyboard.inline_keyboard[0][0].text).toBe("Option A");
    expect(keyboard.inline_keyboard[0][1].text).toBe("Option B");
    expect(keyboard.inline_keyboard[1][0].text).toBe("Option C");
  });

  it("includes callback data with question ID and option index", () => {
    const keyboard = generateQuestionKeyboard("q-123", questionData);

    const callbackA = JSON.parse(keyboard.inline_keyboard[0][0].callback_data!);
    expect(callbackA).toEqual({ t: "q", q: "q-123", o: 0 });

    const callbackB = JSON.parse(keyboard.inline_keyboard[0][1].callback_data!);
    expect(callbackB).toEqual({ t: "q", q: "q-123", o: 1 });
  });

  it("returns empty keyboard when no options", () => {
    const noOptionsData: QuestionBeadData = {
      ...questionData,
      questions: [{ question: "Free text?", header: "Q", options: [], multiSelect: false }],
    };

    const keyboard = generateQuestionKeyboard("q-123", noOptionsData);
    expect(keyboard.inline_keyboard).toHaveLength(0);
  });
});

describe("parseCallbackData", () => {
  it("parses valid callback data", () => {
    const data = JSON.stringify({ t: "q", q: "orc-123", o: 1 });
    const parsed = parseCallbackData(data);

    expect(parsed).toEqual({ t: "q", q: "orc-123", o: 1 });
  });

  it("returns null for invalid JSON", () => {
    expect(parseCallbackData("not json")).toBeNull();
  });

  it("returns null for wrong type", () => {
    expect(parseCallbackData(JSON.stringify({ t: "x", q: "foo", o: 0 }))).toBeNull();
  });

  it("returns null for missing fields", () => {
    expect(parseCallbackData(JSON.stringify({ t: "q" }))).toBeNull();
    expect(parseCallbackData(JSON.stringify({ t: "q", q: "foo" }))).toBeNull();
  });
});
