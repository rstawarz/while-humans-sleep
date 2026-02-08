/**
 * Tests for CommandHandler - /pause, /resume, /status via Telegram
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock state module
vi.mock("../../state.js", () => ({
  getLockInfo: vi.fn(),
  loadState: vi.fn(),
}));

// Mock formatter
vi.mock("../formatter.js", () => ({
  escapeMarkdownV2: vi.fn((text: string) =>
    text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1")
  ),
}));

import { CommandHandler } from "./command.js";
import { getLockInfo, loadState } from "../../state.js";

const mockGetLockInfo = getLockInfo as ReturnType<typeof vi.fn>;
const mockLoadState = loadState as ReturnType<typeof vi.fn>;

function createMockContext(text: string): {
  message: { text: string };
  reply: ReturnType<typeof vi.fn>;
} {
  return {
    message: { text },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CommandHandler", () => {
  let handler: CommandHandler;
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CommandHandler();
    // Mock process.kill to prevent actually sending signals
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    processKillSpy.mockRestore();
  });

  describe("canHandle", () => {
    it("handles /pause command", () => {
      const ctx = createMockContext("/pause");
      expect(handler.canHandle(ctx as any)).toBe(true);
    });

    it("handles /resume command", () => {
      const ctx = createMockContext("/resume");
      expect(handler.canHandle(ctx as any)).toBe(true);
    });

    it("handles /status command", () => {
      const ctx = createMockContext("/status");
      expect(handler.canHandle(ctx as any)).toBe(true);
    });

    it("does not handle other commands", () => {
      const ctx = createMockContext("/help");
      expect(handler.canHandle(ctx as any)).toBe(false);
    });

    it("does not handle plain text", () => {
      const ctx = createMockContext("hello");
      expect(handler.canHandle(ctx as any)).toBe(false);
    });

    it("does not handle empty message", () => {
      const ctx = { message: undefined };
      expect(handler.canHandle(ctx as any)).toBe(false);
    });
  });

  describe("/pause", () => {
    it("replies not running when no dispatcher", async () => {
      mockGetLockInfo.mockReturnValue(null);
      const ctx = createMockContext("/pause");

      await handler.handle(ctx as any);

      expect(ctx.reply).toHaveBeenCalledWith(
        "No dispatcher is running\\.",
        { parse_mode: "MarkdownV2" }
      );
    });

    it("replies already paused when state is paused", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: "2024-01-01" });
      mockLoadState.mockReturnValue({
        paused: true,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });
      const ctx = createMockContext("/pause");

      await handler.handle(ctx as any);

      expect(ctx.reply).toHaveBeenCalledWith(
        "Dispatcher is already paused\\.",
        { parse_mode: "MarkdownV2" }
      );
    });

    it("sends SIGUSR1 and confirms when running", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: "2024-01-01" });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });

      const ctx = createMockContext("/pause");
      await handler.handle(ctx as any);

      expect(processKillSpy).toHaveBeenCalledWith(1234, "SIGUSR1");
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("paused"),
        { parse_mode: "MarkdownV2" }
      );
    });
  });

  describe("/resume", () => {
    it("replies not running when no dispatcher", async () => {
      mockGetLockInfo.mockReturnValue(null);
      const ctx = createMockContext("/resume");

      await handler.handle(ctx as any);

      expect(ctx.reply).toHaveBeenCalledWith(
        "No dispatcher is running\\.",
        { parse_mode: "MarkdownV2" }
      );
    });

    it("replies not paused when dispatcher is running", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: "2024-01-01" });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });
      const ctx = createMockContext("/resume");

      await handler.handle(ctx as any);

      expect(ctx.reply).toHaveBeenCalledWith(
        "Dispatcher is not paused\\.",
        { parse_mode: "MarkdownV2" }
      );
    });

    it("sends SIGUSR2 and confirms when paused", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: "2024-01-01" });
      mockLoadState.mockReturnValue({
        paused: true,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });

      const ctx = createMockContext("/resume");
      await handler.handle(ctx as any);

      expect(processKillSpy).toHaveBeenCalledWith(1234, "SIGUSR2");
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("resumed"),
        { parse_mode: "MarkdownV2" }
      );
    });
  });

  describe("/status", () => {
    it("shows not running when no dispatcher", async () => {
      mockGetLockInfo.mockReturnValue(null);
      const ctx = createMockContext("/status");

      await handler.handle(ctx as any);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("not running"),
        { parse_mode: "MarkdownV2" }
      );
    });

    it("shows running status with details", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: "2024-01-01" });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });
      const ctx = createMockContext("/status");

      await handler.handle(ctx as any);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("Running"),
        { parse_mode: "MarkdownV2" }
      );
    });

    it("shows paused status", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: "2024-01-01" });
      mockLoadState.mockReturnValue({
        paused: true,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });
      const ctx = createMockContext("/status");

      await handler.handle(ctx as any);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("PAUSED"),
        { parse_mode: "MarkdownV2" }
      );
    });

    it("shows active work count and projects", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: "2024-01-01" });
      const activeWork = new Map();
      activeWork.set("bd-123", {
        workItem: { project: "test-project", id: "bd-123" },
        agent: "implementation",
      });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork,
        lastUpdated: new Date(),
      });
      const ctx = createMockContext("/status");

      await handler.handle(ctx as any);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain("Active work: 1");
      expect(replyText).toContain("test\\-project");
    });
  });
});
