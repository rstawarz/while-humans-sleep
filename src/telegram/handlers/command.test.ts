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

// Mock version
vi.mock("../../version.js", () => ({
  VERSION: "0.5.0",
}));

// Mock config
vi.mock("../../config.js", () => ({
  loadConfig: vi.fn(() => ({ orchestratorPath: "/tmp/test-orchestrator" })),
  expandPath: vi.fn((p: string) => p),
}));

// Mock beads
vi.mock("../../beads/index.js", () => ({
  beads: {
    listPendingQuestions: vi.fn(() => []),
    parseQuestionData: vi.fn(),
  },
}));

// Mock workflow
vi.mock("../../workflow.js", () => ({
  getErroredWorkflows: vi.fn(() => []),
}));

// Mock metrics
vi.mock("../../metrics.js", () => ({
  getTodayCost: vi.fn(() => 0),
  getWorkflowSteps: vi.fn(() => []),
}));

import { CommandHandler, formatDuration } from "./command.js";
import { getLockInfo, loadState } from "../../state.js";
import { beads } from "../../beads/index.js";
import { getErroredWorkflows } from "../../workflow.js";
import { getTodayCost, getWorkflowSteps } from "../../metrics.js";

const mockGetLockInfo = getLockInfo as ReturnType<typeof vi.fn>;
const mockLoadState = loadState as ReturnType<typeof vi.fn>;
const mockListPendingQuestions = beads.listPendingQuestions as ReturnType<typeof vi.fn>;
const mockParseQuestionData = beads.parseQuestionData as ReturnType<typeof vi.fn>;
const mockGetErroredWorkflows = getErroredWorkflows as ReturnType<typeof vi.fn>;
const mockGetTodayCost = getTodayCost as ReturnType<typeof vi.fn>;
const mockGetWorkflowSteps = getWorkflowSteps as ReturnType<typeof vi.fn>;

function createMockContext(text: string): {
  message: { text: string };
  reply: ReturnType<typeof vi.fn>;
} {
  return {
    message: { text },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("formatDuration", () => {
  it("returns <1m for less than a minute", () => {
    expect(formatDuration(0)).toBe("<1m");
    expect(formatDuration(30000)).toBe("<1m");
    expect(formatDuration(59999)).toBe("<1m");
  });

  it("returns minutes only when under an hour", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(300000)).toBe("5m");
    expect(formatDuration(3540000)).toBe("59m");
  });

  it("returns hours and minutes", () => {
    expect(formatDuration(3600000)).toBe("1h 0m");
    expect(formatDuration(5400000)).toBe("1h 30m");
    expect(formatDuration(8100000)).toBe("2h 15m");
  });

  it("handles large durations", () => {
    expect(formatDuration(86400000)).toBe("24h 0m");
  });
});

describe("CommandHandler", () => {
  let handler: CommandHandler;
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CommandHandler();
    // Mock process.kill to prevent actually sending signals
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    // Default mock returns
    mockGetTodayCost.mockReturnValue(0);
    mockGetWorkflowSteps.mockReturnValue([]);
    mockGetErroredWorkflows.mockReturnValue([]);
    mockListPendingQuestions.mockReturnValue([]);
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
    it("shows stopped status with version and cost", async () => {
      mockGetLockInfo.mockReturnValue(null);
      mockGetTodayCost.mockReturnValue(1.23);
      const ctx = createMockContext("/status");

      await handler.handle(ctx as any);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain("WHS v0\\.5\\.0");
      expect(replyText).toContain("Stopped");
      expect(replyText).toContain("$1\\.23");
    });

    it("shows running status with uptime", async () => {
      const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: twoHoursAgo });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });
      const ctx = createMockContext("/status");

      await handler.handle(ctx as any);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain("WHS v0\\.5\\.0");
      expect(replyText).toContain("Running");
      expect(replyText).toContain("PID 1234");
      expect(replyText).toContain("2h 0m");
    });

    it("shows paused status", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: new Date().toISOString() });
      mockLoadState.mockReturnValue({
        paused: true,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });
      const ctx = createMockContext("/status");

      await handler.handle(ctx as any);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain("PAUSED");
    });

    it("shows active work with title, source, agent, and step number", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: new Date().toISOString() });
      const activeWork = new Map();
      activeWork.set("orc-abc.1", {
        workItem: {
          project: "bridget_ai",
          id: "bai-zv0.1",
          title: "Implement auth service",
        },
        workflowEpicId: "orc-abc",
        workflowStepId: "orc-abc.3",
        agent: "quality_review",
        startedAt: new Date(Date.now() - 2700000), // 45m ago
        costSoFar: 0.32,
      });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork,
        lastUpdated: new Date(),
      });

      // 2 completed steps before this one
      mockGetWorkflowSteps.mockReturnValue([
        { id: "orc-abc.1", completed_at: "2024-01-01", agent: "implementation" },
        { id: "orc-abc.2", completed_at: "2024-01-01", agent: "implementation" },
        { id: "orc-abc.3", completed_at: null, agent: "quality_review" },
      ]);

      const ctx = createMockContext("/status");
      await handler.handle(ctx as any);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain("Active Work");
      expect(replyText).toContain("Implement auth service");
      expect(replyText).toContain("bridget\\_ai/bai\\-zv0\\.1");
      expect(replyText).toContain("quality\\_review");
      expect(replyText).toContain("step 3");
      expect(replyText).toContain("45m");
      expect(replyText).toContain("$0\\.32");
    });

    it("shows pending questions with details", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: new Date().toISOString() });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });

      mockListPendingQuestions.mockReturnValue([
        {
          id: "orc-q1",
          title: "Question: Auth method",
          description: "{}",
        },
      ]);
      mockParseQuestionData.mockReturnValue({
        questions: [{ question: "Which auth method should we use?" }],
        metadata: { project: "bridget_ai" },
      });

      const ctx = createMockContext("/status");
      await handler.handle(ctx as any);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain("Questions");
      expect(replyText).toContain("Which auth method should we use?");
      expect(replyText).toContain("bridget\\_ai");
    });

    it("shows errored workflows with details", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: new Date().toISOString() });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });

      mockGetErroredWorkflows.mockReturnValue([
        {
          epicId: "orc-err1",
          errorType: "auth",
          sourceProject: "bridget_ai",
          sourceBeadId: "bai-zv0.2",
        },
      ]);

      const ctx = createMockContext("/status");
      await handler.handle(ctx as any);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain("Errored");
      expect(replyText).toContain("bridget\\_ai/bai\\-zv0\\.2");
      expect(replyText).toContain("auth");
    });

    it("shows today cost", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: new Date().toISOString() });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });
      mockGetTodayCost.mockReturnValue(4.56);

      const ctx = createMockContext("/status");
      await handler.handle(ctx as any);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain("$4\\.56");
    });

    it("handles errors in data fetching gracefully", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: new Date().toISOString() });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork: new Map(),
        lastUpdated: new Date(),
      });
      mockListPendingQuestions.mockImplementation(() => { throw new Error("db error"); });
      mockGetErroredWorkflows.mockImplementation(() => { throw new Error("db error"); });
      mockGetTodayCost.mockImplementation(() => { throw new Error("db error"); });

      const ctx = createMockContext("/status");
      await handler.handle(ctx as any);

      const replyText = ctx.reply.mock.calls[0][0];
      // Should still render without crashing
      expect(replyText).toContain("Questions: 0");
      expect(replyText).toContain("Errored: 0");
      expect(replyText).toContain("$0\\.00");
    });

    it("shows step 1 when no previous steps exist", async () => {
      mockGetLockInfo.mockReturnValue({ pid: 1234, startedAt: new Date().toISOString() });
      const activeWork = new Map();
      activeWork.set("orc-x.1", {
        workItem: {
          project: "myproj",
          id: "mp-001",
          title: "First task",
        },
        workflowEpicId: "orc-x",
        workflowStepId: "orc-x.1",
        agent: "implementation",
        startedAt: new Date(Date.now() - 60000),
        costSoFar: 0,
      });
      mockLoadState.mockReturnValue({
        paused: false,
        activeWork,
        lastUpdated: new Date(),
      });
      mockGetWorkflowSteps.mockReturnValue([
        { id: "orc-x.1", completed_at: null, agent: "implementation" },
      ]);

      const ctx = createMockContext("/status");
      await handler.handle(ctx as any);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain("step 1");
    });
  });
});
