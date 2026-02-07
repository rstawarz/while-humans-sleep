/**
 * Tests for Telegram message store
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../metrics.js";
import { MessageStore } from "./message-store.js";

describe("MessageStore", () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temp directory for the test database
    tempDir = mkdtempSync(join(tmpdir(), "whs-telegram-test-"));
    const dbPath = join(tempDir, "metrics.db");
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("store", () => {
    it("stores a message context and returns it with ID", () => {
      const store = new MessageStore();

      const ctx = store.store({
        messageId: 12345,
        chatId: "67890",
        type: "question",
        contextId: "orc-abc.q1",
        answered: false,
        createdAt: new Date("2024-01-15T10:00:00Z"),
        answeredAt: null,
      });

      expect(ctx.id).toBeDefined();
      expect(ctx.id).toBeGreaterThan(0);
      expect(ctx.messageId).toBe(12345);
      expect(ctx.type).toBe("question");
    });
  });

  describe("getByMessageId", () => {
    it("retrieves stored message by Telegram message ID", () => {
      const store = new MessageStore();

      store.store({
        messageId: 11111,
        chatId: "chat-1",
        type: "question",
        contextId: "q-1",
        answered: false,
        createdAt: new Date(),
        answeredAt: null,
      });

      const retrieved = store.getByMessageId(11111);

      expect(retrieved).toBeDefined();
      expect(retrieved?.contextId).toBe("q-1");
    });

    it("returns undefined for unknown message ID", () => {
      const store = new MessageStore();

      const retrieved = store.getByMessageId(99999);

      expect(retrieved).toBeUndefined();
    });
  });

  describe("getByContextId", () => {
    it("retrieves message by context ID", () => {
      const store = new MessageStore();

      store.store({
        messageId: 22222,
        chatId: "chat-1",
        type: "question",
        contextId: "orc-xyz.q1",
        answered: false,
        createdAt: new Date(),
        answeredAt: null,
      });

      const retrieved = store.getByContextId("orc-xyz.q1");

      expect(retrieved).toBeDefined();
      expect(retrieved?.messageId).toBe(22222);
    });
  });

  describe("markAnswered", () => {
    it("marks a message as answered", () => {
      const store = new MessageStore();

      store.store({
        messageId: 33333,
        chatId: "chat-1",
        type: "question",
        contextId: "q-answer-test",
        answered: false,
        createdAt: new Date(),
        answeredAt: null,
      });

      store.markAnswered(33333);

      const retrieved = store.getByMessageId(33333);
      expect(retrieved?.answered).toBe(true);
      expect(retrieved?.answeredAt).toBeDefined();
    });

    it("removes message from unanswered cache", () => {
      const store = new MessageStore();

      store.store({
        messageId: 44444,
        chatId: "chat-1",
        type: "question",
        contextId: "q-cache-test",
        answered: false,
        createdAt: new Date(),
        answeredAt: null,
      });

      const beforeAnswer = store.getUnansweredQuestions();
      expect(beforeAnswer.some((m) => m.messageId === 44444)).toBe(true);

      store.markAnswered(44444);

      const afterAnswer = store.getUnansweredQuestions();
      expect(afterAnswer.some((m) => m.messageId === 44444)).toBe(false);
    });
  });

  describe("getUnansweredQuestions", () => {
    it("returns only unanswered questions", () => {
      const store = new MessageStore();

      store.store({
        messageId: 55555,
        chatId: "chat-1",
        type: "question",
        contextId: "q-1",
        answered: false,
        createdAt: new Date(),
        answeredAt: null,
      });

      store.store({
        messageId: 55556,
        chatId: "chat-1",
        type: "question",
        contextId: "q-2",
        answered: true,
        createdAt: new Date(),
        answeredAt: new Date(),
      });

      const unanswered = store.getUnansweredQuestions();

      expect(unanswered).toHaveLength(1);
      expect(unanswered[0].messageId).toBe(55555);
    });

    it("excludes non-question types", () => {
      const store = new MessageStore();

      store.store({
        messageId: 66666,
        chatId: "chat-1",
        type: "notification",
        contextId: null,
        answered: false,
        createdAt: new Date(),
        answeredAt: null,
      });

      const unanswered = store.getUnansweredQuestions();

      expect(unanswered).toHaveLength(0);
    });
  });

  describe("hasQuestionBeenSent", () => {
    it("returns true if question was already sent", () => {
      const store = new MessageStore();

      store.store({
        messageId: 77777,
        chatId: "chat-1",
        type: "question",
        contextId: "orc-dup.q1",
        answered: false,
        createdAt: new Date(),
        answeredAt: null,
      });

      expect(store.hasQuestionBeenSent("orc-dup.q1")).toBe(true);
    });

    it("returns false if question was not sent", () => {
      const store = new MessageStore();

      expect(store.hasQuestionBeenSent("orc-unknown.q1")).toBe(false);
    });
  });

  describe("hydration", () => {
    it("hydrates unanswered questions from database on construction", () => {
      // Store a question
      const store1 = new MessageStore();
      store1.store({
        messageId: 88888,
        chatId: "chat-1",
        type: "question",
        contextId: "q-hydrate",
        answered: false,
        createdAt: new Date(),
        answeredAt: null,
      });

      // Create a new store (simulates restart)
      const store2 = new MessageStore();
      const unanswered = store2.getUnansweredQuestions();

      expect(unanswered.some((m) => m.messageId === 88888)).toBe(true);
    });

    it("does not hydrate answered questions", () => {
      const store1 = new MessageStore();
      store1.store({
        messageId: 99999,
        chatId: "chat-1",
        type: "question",
        contextId: "q-hydrate-answered",
        answered: true,
        createdAt: new Date(),
        answeredAt: new Date(),
      });

      const store2 = new MessageStore();
      const unanswered = store2.getUnansweredQuestions();

      expect(unanswered.some((m) => m.messageId === 99999)).toBe(false);
    });
  });
});
