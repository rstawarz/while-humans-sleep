/**
 * Telegram Integration - Public Exports
 *
 * Provides Telegram bot integration for WHS:
 * - Question answering via replies and inline buttons
 * - Notification sending (Phase 2)
 * - Status commands (Phase 3)
 */

export { TelegramService, createTelegramService } from "./service.js";
export { MessageStore } from "./message-store.js";
export { QuestionHandler } from "./handlers/question.js";
export { CommandHandler } from "./handlers/command.js";
export { runSetupWizard, validateTelegramConfig, loadBotToken } from "./setup.js";
export {
  formatQuestionMessage,
  escapeMarkdownV2,
  generateQuestionKeyboard,
  parseCallbackData,
} from "./formatter.js";
export type { TelegramHandler } from "./handlers/types.js";
export type {
  MessageContext,
  CallbackData,
  SendMessageOptions,
  InlineKeyboardMarkup,
  InlineKeyboardButton,
} from "./types.js";
