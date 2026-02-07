/**
 * Telegram Message Formatter
 *
 * Utilities for formatting messages for Telegram with MarkdownV2
 * and generating inline keyboards for questions.
 */

import type { QuestionBeadData } from "../types.js";
import type { CallbackData, InlineKeyboardMarkup } from "./types.js";

/**
 * Escape special characters for Telegram MarkdownV2
 * https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMarkdownV2(text: string): string {
  // Characters that must be escaped: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Format a question message for Telegram
 */
export function formatQuestionMessage(
  questionBeadId: string,
  data: QuestionBeadData
): { text: string; keyboard: InlineKeyboardMarkup } {
  const lines: string[] = [];

  // Header
  lines.push(`*Question from ${escapeMarkdownV2(data.metadata.project)}*`);
  lines.push(`Step: \`${escapeMarkdownV2(data.metadata.step_id)}\``);
  lines.push("");

  // Context (if present)
  if (data.context) {
    lines.push("_Context:_");
    // Truncate long context and escape
    const contextLines = data.context.split("\n").slice(0, 5);
    for (const line of contextLines) {
      lines.push(escapeMarkdownV2(line));
    }
    if (data.context.split("\n").length > 5) {
      lines.push("\\.\\.\\.");
    }
    lines.push("");
  }

  // Questions (usually just one)
  for (const q of data.questions) {
    lines.push(`*Q: ${escapeMarkdownV2(q.question)}*`);

    // List options in the message as well
    if (q.options && q.options.length > 0) {
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const desc = opt.description
          ? ` \\- ${escapeMarkdownV2(opt.description)}`
          : "";
        lines.push(`  ${i + 1}\\. ${escapeMarkdownV2(opt.label)}${desc}`);
      }
    }
  }

  lines.push("");
  lines.push("_Reply to this message or tap a button below\\._");

  // Generate inline keyboard from options
  const keyboard = generateQuestionKeyboard(questionBeadId, data);

  return {
    text: lines.join("\n"),
    keyboard,
  };
}

/**
 * Generate inline keyboard for a question
 */
export function generateQuestionKeyboard(
  questionBeadId: string,
  data: QuestionBeadData
): InlineKeyboardMarkup {
  const buttons: { text: string; callback_data: string }[][] = [];

  // Get options from the first question (usually there's just one)
  const question = data.questions[0];
  if (!question?.options || question.options.length === 0) {
    return { inline_keyboard: [] };
  }

  // Create a row for each option (or two per row if many options)
  const row: { text: string; callback_data: string }[] = [];

  for (let i = 0; i < question.options.length; i++) {
    const opt = question.options[i];
    const callbackData: CallbackData = {
      t: "q",
      q: questionBeadId,
      o: i,
    };

    row.push({
      text: opt.label,
      callback_data: JSON.stringify(callbackData),
    });

    // Two buttons per row
    if (row.length === 2 || i === question.options.length - 1) {
      buttons.push([...row]);
      row.length = 0;
    }
  }

  return { inline_keyboard: buttons };
}

/**
 * Parse callback data from a button press
 */
export function parseCallbackData(data: string): CallbackData | null {
  try {
    const parsed = JSON.parse(data) as CallbackData;
    if (parsed.t === "q" && typeof parsed.q === "string" && typeof parsed.o === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format a confirmation message after an answer is submitted
 */
export function formatAnswerConfirmation(questionBeadId: string): string {
  return `\\u2713 Answer recorded for \`${escapeMarkdownV2(questionBeadId)}\`\nDispatcher will resume the agent\\.`;
}

/**
 * Format an error message
 */
export function formatError(message: string): string {
  return `\\u274C Error: ${escapeMarkdownV2(message)}`;
}
