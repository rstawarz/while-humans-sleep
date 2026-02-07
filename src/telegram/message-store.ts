/**
 * Telegram Message Store - SQLite-backed message context storage
 *
 * Persists the mapping between Telegram message IDs and WHS context
 * (question beads, step IDs, etc.) to handle replies and callbacks.
 */

import type { Database } from "better-sqlite3";
import { getMetricsDb } from "../metrics.js";
import type { MessageContext } from "./types.js";

/**
 * Row type returned from SQLite
 */
interface MessageRow {
  id: number;
  message_id: number;
  chat_id: string;
  type: string;
  context_id: string | null;
  answered: number;
  created_at: string;
  answered_at: string | null;
}

/**
 * SQLite-backed store for Telegram message context
 *
 * Uses the shared metrics.db to persist message mappings.
 * Maintains an in-memory cache of unanswered questions for fast lookups.
 */
export class MessageStore {
  private db: Database;
  private cache: Map<number, MessageContext> = new Map();

  constructor() {
    this.db = getMetricsDb();
    this.ensureSchema();
    this.hydrate();
  }

  /**
   * Create table if not exists
   */
  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        type TEXT NOT NULL,
        context_id TEXT,
        answered INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        UNIQUE(message_id, chat_id)
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_messages_type
        ON telegram_messages(type);
      CREATE INDEX IF NOT EXISTS idx_telegram_messages_context
        ON telegram_messages(context_id);
    `);
  }

  /**
   * Load unanswered questions into memory cache
   */
  private hydrate(): void {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM telegram_messages
      WHERE type = 'question' AND answered = 0
    `
      )
      .all() as MessageRow[];

    for (const row of rows) {
      this.cache.set(row.message_id, this.rowToContext(row));
    }
  }

  /**
   * Convert a database row to MessageContext
   */
  private rowToContext(row: MessageRow): MessageContext {
    return {
      id: row.id,
      messageId: row.message_id,
      chatId: row.chat_id,
      type: row.type as MessageContext["type"],
      contextId: row.context_id,
      answered: row.answered === 1,
      createdAt: new Date(row.created_at),
      answeredAt: row.answered_at ? new Date(row.answered_at) : null,
    };
  }

  /**
   * Store a new message context
   */
  store(ctx: Omit<MessageContext, "id">): MessageContext {
    const stmt = this.db.prepare(`
      INSERT INTO telegram_messages (message_id, chat_id, type, context_id, answered, created_at, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      ctx.messageId,
      ctx.chatId,
      ctx.type,
      ctx.contextId,
      ctx.answered ? 1 : 0,
      ctx.createdAt.toISOString(),
      ctx.answeredAt?.toISOString() ?? null
    );

    const stored: MessageContext = {
      ...ctx,
      id: result.lastInsertRowid as number,
    };

    // Add to cache if it's an unanswered question
    if (ctx.type === "question" && !ctx.answered) {
      this.cache.set(ctx.messageId, stored);
    }

    return stored;
  }

  /**
   * Get by Telegram message ID (from cache or DB)
   */
  getByMessageId(messageId: number): MessageContext | undefined {
    // Check cache first
    const cached = this.cache.get(messageId);
    if (cached) return cached;

    // Fall back to DB
    const row = this.db
      .prepare(`SELECT * FROM telegram_messages WHERE message_id = ?`)
      .get(messageId) as MessageRow | undefined;

    return row ? this.rowToContext(row) : undefined;
  }

  /**
   * Get by context ID (e.g., question bead ID)
   */
  getByContextId(contextId: string): MessageContext | undefined {
    const row = this.db
      .prepare(`SELECT * FROM telegram_messages WHERE context_id = ?`)
      .get(contextId) as MessageRow | undefined;

    return row ? this.rowToContext(row) : undefined;
  }

  /**
   * Mark a question as answered
   */
  markAnswered(messageId: number): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
      UPDATE telegram_messages
      SET answered = 1, answered_at = ?
      WHERE message_id = ?
    `
      )
      .run(now, messageId);

    // Remove from cache
    this.cache.delete(messageId);
  }

  /**
   * Get unanswered questions (from cache)
   */
  getUnansweredQuestions(): MessageContext[] {
    return Array.from(this.cache.values());
  }

  /**
   * Check if a question bead has already been sent
   */
  hasQuestionBeenSent(questionBeadId: string): boolean {
    const row = this.db
      .prepare(
        `
      SELECT 1 FROM telegram_messages
      WHERE type = 'question' AND context_id = ?
      LIMIT 1
    `
      )
      .get(questionBeadId);

    return row !== undefined;
  }
}
