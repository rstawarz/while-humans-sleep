/**
 * Telegram Handler Interface
 *
 * Handlers implement this interface to process specific message types.
 * The TelegramService routes incoming messages through the handler chain.
 */

import type { Context } from "grammy";

/**
 * Handler for processing incoming Telegram messages
 * New handlers can be added for commands, documents, etc.
 */
export interface TelegramHandler {
  /** Unique name for logging */
  readonly name: string;

  /** Check if this handler should process the message */
  canHandle(ctx: Context): boolean | Promise<boolean>;

  /** Process the message. Return true if handled, false to continue chain */
  handle(ctx: Context): Promise<boolean>;
}
