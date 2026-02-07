/**
 * Telegram Service - Main Telegram bot orchestrator
 *
 * Manages:
 * - Grammy bot lifecycle
 * - Handler chain routing
 * - Polling for pending questions to send
 */

import { Bot } from "grammy";
import type { Context } from "grammy";
import type { TelegramHandler } from "./handlers/types.js";
import { MessageStore } from "./message-store.js";
import { QuestionHandler } from "./handlers/question.js";
import { beads } from "../beads/index.js";
import { loadConfig, expandPath } from "../config.js";
import type { Notifier, QuestionBeadData, ActiveWork } from "../types.js";

/**
 * Poll interval for checking new questions to send (ms)
 */
const DEFAULT_POLL_INTERVAL = 5000;

/**
 * Telegram bot service for WHS notifications and question handling
 */
export class TelegramService implements Notifier {
  private bot: Bot;
  private handlers: TelegramHandler[] = [];
  private messageStore: MessageStore;
  private questionHandler: QuestionHandler;
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private chatId: string;

  constructor(botToken: string, chatId: string) {
    this.bot = new Bot(botToken);
    this.chatId = chatId;
    this.messageStore = new MessageStore();
    this.questionHandler = new QuestionHandler(this.messageStore, chatId);

    // Register the question handler by default
    this.registerHandler(this.questionHandler);

    // Set up message routing
    this.setupRouting();
  }

  /**
   * Register a handler (order matters - first match wins)
   */
  registerHandler(handler: TelegramHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Set up Grammy message routing
   */
  private setupRouting(): void {
    // Route all messages and callbacks through our handler chain
    this.bot.on("message", async (ctx) => {
      await this.routeMessage(ctx);
    });

    this.bot.on("callback_query:data", async (ctx) => {
      await this.routeMessage(ctx);
    });

    // Handle errors
    this.bot.catch((err) => {
      console.error("[Telegram] Bot error:", err);
    });
  }

  /**
   * Route incoming messages through handler chain
   */
  private async routeMessage(ctx: Context): Promise<void> {
    for (const handler of this.handlers) {
      try {
        if (await handler.canHandle(ctx)) {
          const handled = await handler.handle(ctx);
          if (handled) return;
        }
      } catch (err) {
        console.error(`[Telegram] Handler ${handler.name} error:`, err);
      }
    }
  }

  /**
   * Send a message to the configured chat
   */
  async sendMessage(
    text: string,
    options?: { parse_mode?: string; reply_markup?: unknown }
  ): Promise<{ message_id: number }> {
    return this.bot.api.sendMessage(this.chatId, text, options as Parameters<typeof this.bot.api.sendMessage>[2]);
  }

  /**
   * Poll for pending questions and send them
   */
  private async pollForQuestions(): Promise<void> {
    try {
      const config = loadConfig();
      const orchestratorPath = expandPath(config.orchestratorPath);
      const pendingQuestions = beads.listPendingQuestions(orchestratorPath);

      for (const questionBead of pendingQuestions) {
        // Check if we've already sent this question
        if (this.messageStore.hasQuestionBeenSent(questionBead.id)) {
          continue;
        }

        const questionData = beads.parseQuestionData(questionBead);
        await this.questionHandler.sendQuestion(
          questionBead.id,
          questionData,
          (text, opts) => this.sendMessage(text, opts)
        );
      }
    } catch (err) {
      console.error("[Telegram] Poll error:", err);
    }
  }

  /**
   * Start the bot and polling
   */
  async start(pollInterval: number = DEFAULT_POLL_INTERVAL): Promise<void> {
    if (this.running) {
      console.warn("[Telegram] Service already running");
      return;
    }

    this.running = true;

    // Start the bot (long polling)
    this.bot.start({
      onStart: () => {
        console.log("[Telegram] Bot started");
      },
    });

    // Start polling for questions to send
    this.pollTimer = setInterval(() => {
      this.pollForQuestions();
    }, pollInterval);

    // Do an immediate poll
    await this.pollForQuestions();
  }

  /**
   * Stop the bot gracefully
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    await this.bot.stop();
    console.log("[Telegram] Bot stopped");
  }

  // === Notifier interface implementation ===

  async notifyQuestion(questionBeadId: string, data: QuestionBeadData): Promise<void> {
    await this.questionHandler.sendQuestion(
      questionBeadId,
      data,
      (text, opts) => this.sendMessage(text, opts)
    );
  }

  async notifyProgress(work: ActiveWork, message: string): Promise<void> {
    // Phase 2: Progress notifications
    // For now, only log locally
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
    console.log(`[${timestamp}] [${work.workItem.project}/${work.workItem.id}] ${message}`);
  }

  async notifyComplete(work: ActiveWork, result: "done" | "blocked"): Promise<void> {
    // Phase 2: Completion notifications
    const emoji = result === "done" ? "\\u2705" : "\\u26D4";
    const message = `${emoji} *${result.toUpperCase()}*: ${work.workItem.project}/${work.workItem.id}\nAgent: ${work.agent}\nCost: \\$${work.costSoFar.toFixed(4)}`;

    try {
      await this.sendMessage(message, { parse_mode: "MarkdownV2" });
    } catch (err) {
      console.error("[Telegram] Failed to send completion notification:", err);
    }
  }

  async notifyError(work: ActiveWork, error: Error): Promise<void> {
    // Phase 2: Error notifications
    const message = `\\u274C *ERROR* in ${work.workItem.project}/${work.workItem.id}\nAgent: ${work.agent}\nError: ${error.message.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1")}`;

    try {
      await this.sendMessage(message, { parse_mode: "MarkdownV2" });
    } catch (err) {
      console.error("[Telegram] Failed to send error notification:", err);
    }
  }

  async notifyRateLimit(error: Error): Promise<void> {
    const message = `\\u26A0\\uFE0F *RATE LIMIT HIT* \\- Dispatcher paused\nError: ${error.message.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1")}\nRun \\'whs resume\\' when ready to continue\\.`;

    try {
      await this.sendMessage(message, { parse_mode: "MarkdownV2" });
    } catch (err) {
      console.error("[Telegram] Failed to send rate limit notification:", err);
    }
  }
}

/**
 * Create a TelegramService from config
 */
export function createTelegramService(
  botToken: string,
  chatId: string
): TelegramService {
  return new TelegramService(botToken, chatId);
}
