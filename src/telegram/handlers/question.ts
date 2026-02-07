/**
 * Question Handler - Handles question answers via Telegram
 *
 * This handler processes:
 * 1. Text replies to question messages
 * 2. Inline button callbacks
 *
 * When an answer is received, it:
 * 1. Looks up the question context from the message store
 * 2. Submits the answer via the questions service
 * 3. Sends a confirmation message
 */

import type { Context } from "grammy";
import type { TelegramHandler } from "./types.js";
import type { MessageStore } from "../message-store.js";
import type { QuestionBeadData } from "../../types.js";
import { submitAnswer } from "../../questions.js";
import {
  formatQuestionMessage,
  parseCallbackData,
  escapeMarkdownV2,
} from "../formatter.js";
import { beads } from "../../beads/index.js";
import { loadConfig, expandPath } from "../../config.js";

/**
 * Handler for question answers via replies and callbacks
 */
export class QuestionHandler implements TelegramHandler {
  readonly name = "question";

  constructor(
    private messageStore: MessageStore,
    private chatId: string
  ) {}

  /**
   * Check if this handler should process the message
   * Handles: replies to question messages OR callback queries
   */
  canHandle(ctx: Context): boolean {
    // Handle callback queries (button presses)
    if (ctx.callbackQuery?.data) {
      const data = parseCallbackData(ctx.callbackQuery.data);
      return data !== null && data.t === "q";
    }

    // Handle text replies to our messages
    if (ctx.message?.reply_to_message && ctx.message.text) {
      const replyToId = ctx.message.reply_to_message.message_id;
      const msgContext = this.messageStore.getByMessageId(replyToId);
      return msgContext?.type === "question" && !msgContext.answered;
    }

    return false;
  }

  /**
   * Process the message
   */
  async handle(ctx: Context): Promise<boolean> {
    if (ctx.callbackQuery) {
      return this.handleCallback(ctx);
    }
    return this.handleReply(ctx);
  }

  /**
   * Send a question to Telegram
   */
  async sendQuestion(
    questionBeadId: string,
    data: QuestionBeadData,
    sendMessage: (
      text: string,
      options?: { parse_mode?: string; reply_markup?: unknown }
    ) => Promise<{ message_id: number }>
  ): Promise<void> {
    // Check if we've already sent this question
    if (this.messageStore.hasQuestionBeenSent(questionBeadId)) {
      return;
    }

    const { text, keyboard } = formatQuestionMessage(questionBeadId, data);

    const msg = await sendMessage(text, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
    });

    // Store the message mapping
    this.messageStore.store({
      messageId: msg.message_id,
      chatId: this.chatId,
      type: "question",
      contextId: questionBeadId,
      answered: false,
      createdAt: new Date(),
      answeredAt: null,
    });
  }

  /**
   * Handle a text reply to a question message
   */
  private async handleReply(ctx: Context): Promise<boolean> {
    const replyToId = ctx.message?.reply_to_message?.message_id;
    const answerText = ctx.message?.text;

    if (!replyToId || !answerText) {
      return false;
    }

    const msgContext = this.messageStore.getByMessageId(replyToId);
    if (!msgContext || msgContext.type !== "question" || !msgContext.contextId) {
      return false;
    }

    return this.submitAnswerAndConfirm(ctx, msgContext.contextId, answerText);
  }

  /**
   * Handle a callback query (button press)
   */
  private async handleCallback(ctx: Context): Promise<boolean> {
    const callbackData = ctx.callbackQuery?.data;
    if (!callbackData) return false;

    const data = parseCallbackData(callbackData);
    if (!data || data.t !== "q") return false;

    // Get the question bead to find the option label
    const config = loadConfig();
    const orchestratorPath = expandPath(config.orchestratorPath);
    const pendingQuestions = beads.listPendingQuestions(orchestratorPath);
    const questionBead = pendingQuestions.find((b) => b.id === data.q);

    if (!questionBead) {
      await ctx.answerCallbackQuery({
        text: "This question has already been answered.",
        show_alert: true,
      });
      return true;
    }

    const questionData = beads.parseQuestionData(questionBead);
    const option = questionData.questions[0]?.options?.[data.o];

    if (!option) {
      await ctx.answerCallbackQuery({
        text: "Invalid option selected.",
        show_alert: true,
      });
      return true;
    }

    // Answer the callback query first (removes loading state)
    await ctx.answerCallbackQuery({ text: `Selected: ${option.label}` });

    return this.submitAnswerAndConfirm(ctx, data.q, option.label);
  }

  /**
   * Submit an answer and send confirmation
   */
  private async submitAnswerAndConfirm(
    ctx: Context,
    questionBeadId: string,
    answer: string
  ): Promise<boolean> {
    const result = submitAnswer(questionBeadId, answer);

    if (!result.success) {
      await ctx.reply(`Error: ${escapeMarkdownV2(result.error || "Unknown error")}`, {
        parse_mode: "MarkdownV2",
      });
      return true;
    }

    // Mark as answered in our store
    const msgContext = this.messageStore.getByContextId(questionBeadId);
    if (msgContext) {
      this.messageStore.markAnswered(msgContext.messageId);
    }

    // Send confirmation
    await ctx.reply(
      `\u2713 Answer recorded for \`${escapeMarkdownV2(questionBeadId)}\`\nDispatcher will resume the agent\\.`,
      { parse_mode: "MarkdownV2" }
    );

    return true;
  }
}
