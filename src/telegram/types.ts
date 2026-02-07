/**
 * Telegram Types - Shared types for the Telegram integration
 */

/**
 * Stored context for a Telegram message
 * Used to map message_id back to question/step context
 */
export interface MessageContext {
  id: number;
  messageId: number;
  chatId: string;
  type: "question" | "notification" | "status";
  contextId: string | null;
  answered: boolean;
  createdAt: Date;
  answeredAt: Date | null;
}

/**
 * Callback data for inline keyboard buttons
 * Compact format to fit Telegram's 64-byte limit
 */
export interface CallbackData {
  /** Type: "q" for question */
  t: "q";
  /** Question bead ID */
  q: string;
  /** Option index (0-based) */
  o: number;
}

/**
 * Options for sending a Telegram message
 */
export interface SendMessageOptions {
  parseMode?: "MarkdownV2" | "HTML";
  replyMarkup?: InlineKeyboardMarkup;
  replyToMessageId?: number;
}

/**
 * Inline keyboard markup for Telegram
 */
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * Inline keyboard button
 */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
}
