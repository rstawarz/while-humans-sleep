/**
 * End-to-end integration tests for the Dispatcher
 *
 * These tests mock external dependencies (beads CLI, worktree, agent SDK)
 * and verify the full workflow from picking up work to completion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config, Project, WorkItem, ActiveWork, Notifier } from "./types.js";

// Mock all external modules before importing dispatcher
vi.mock("./beads/index.js", () => ({
  beads: {
    ready: vi.fn(),
    create: vi.fn(),
    close: vi.fn(),
    update: vi.fn(),
    comment: vi.fn(),
    show: vi.fn(),
    list: vi.fn(),
    isDaemonRunning: vi.fn(() => true),
    ensureDaemonWithSyncBranch: vi.fn(),
    // Question bead methods
    createQuestion: vi.fn(() => ({ id: "q-001" })),
    listPendingQuestions: vi.fn(() => []),
    parseQuestionData: vi.fn(),
    answerQuestion: vi.fn(),
  },
}));

vi.mock("./config.js", () => ({
  loadConfig: vi.fn(),
  expandPath: vi.fn((p: string) => p.replace("~", "/home/user")),
}));

vi.mock("./state.js", () => {
  const createEmptyState = () => ({
    activeWork: new Map(),
    paused: false,
    lastUpdated: new Date(),
  });

  return {
    loadState: vi.fn(() => createEmptyState()),
    saveState: vi.fn(),
    addActiveWork: vi.fn((state, work) => {
      const newState = { ...state, activeWork: new Map(state.activeWork) };
      newState.activeWork.set(work.workItem.id, work);
      return newState;
    }),
    removeActiveWork: vi.fn((state, id) => {
      const newState = { ...state, activeWork: new Map(state.activeWork) };
      newState.activeWork.delete(id);
      return newState;
    }),
    updateActiveWork: vi.fn((state, id, updates) => {
      const newState = { ...state, activeWork: new Map(state.activeWork) };
      const existing = newState.activeWork.get(id);
      if (existing) {
        newState.activeWork.set(id, { ...existing, ...updates });
      }
      return newState;
    }),
    setPaused: vi.fn((state, paused) => ({ ...state, paused })),
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
    getLockInfo: vi.fn(() => null),
  };
});

vi.mock("./workflow.js", () => ({
  startWorkflow: vi.fn(),
  createNextStep: vi.fn(),
  completeStep: vi.fn(),
  completeWorkflow: vi.fn(),
  getWorkflowContext: vi.fn(() => ""),
  getWorkflowEpic: vi.fn(),
  getReadyWorkflowSteps: vi.fn(() => []),
  getSourceBeadInfo: vi.fn(),
  getFirstAgent: vi.fn(() => "implementation"),
  markStepInProgress: vi.fn(),
  resetStepForRetry: vi.fn(() => true),
  getWorkflowForSource: vi.fn(() => null),
  getStepResumeInfo: vi.fn(() => null),
  clearStepResumeInfo: vi.fn(),
  // CI checking functions
  getStepsPendingCI: vi.fn(() => []),
  updateStepCIStatus: vi.fn(),
  epicHasLabel: vi.fn(() => false),
  addEpicLabel: vi.fn(),
  // Error recovery functions
  errorWorkflow: vi.fn(),
  getErroredWorkflows: vi.fn(() => []),
  retryWorkflow: vi.fn(),
}));

vi.mock("./worktree.js", () => ({
  ensureWorktree: vi.fn(() => "/tmp/worktree/test-project/bd-123"),
  removeWorktree: vi.fn(),
}));

vi.mock("./agent-runner.js", () => ({
  formatAgentPrompt: vi.fn(({ taskTitle }) => `Work on: ${taskTitle}`),
}));

// Create a mock agent runner that can be configured per test
const mockAgentRunnerInstance = {
  run: vi.fn(),
  resumeWithAnswer: vi.fn(),
  abort: vi.fn(),
};

vi.mock("./agent-runner-factory.js", () => ({
  createAgentRunner: vi.fn(() => mockAgentRunnerInstance),
}));

vi.mock("./handoff.js", () => ({
  getHandoff: vi.fn(),
  isValidAgent: vi.fn((agent) =>
    ["implementation", "quality_review", "release_manager", "ux_specialist", "architect", "planner", "DONE", "BLOCKED"].includes(agent)
  ),
}));

// Helper to wait for async operations to complete
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("Dispatcher E2E", () => {
  let mockBeads: any;
  let mockWorkflow: any;
  let mockWorktree: any;
  let mockAgentRunner: any;
  let mockHandoff: any;
  let mockState: any;
  let mockNotifier: Notifier;

  const testConfig: Config = {
    projects: [
      {
        name: "test-project",
        repoPath: "/home/user/work/test-project",
        baseBranch: "main",
        agentsPath: "docs/llm/agents",
        beadsMode: "committed",
      },
    ],
    orchestratorPath: "/home/user/work/whs-orchestrator",
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
      runnerType: "cli",
  };

  const testBead = {
    id: "bd-123",
    title: "Add user authentication",
    description: "Implement JWT-based auth",
    priority: 1,
    type: "task",
    status: "open",
    dependencies: [],
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Get mocked modules
    mockBeads = (await import("./beads/index.js")).beads;
    mockWorkflow = await import("./workflow.js");
    mockWorktree = await import("./worktree.js");
    mockAgentRunner = await import("./agent-runner.js");
    mockHandoff = await import("./handoff.js");
    mockState = await import("./state.js");

    // Create mock notifier
    mockNotifier = {
      notifyQuestion: vi.fn(),
      notifyProgress: vi.fn(),
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      notifyRateLimit: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Workflow: New task to completion", () => {
    it("picks up new work from project beads and starts workflow", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      // Setup: Project has a ready bead
      mockBeads.ready.mockReturnValue([testBead]);

      // Workflow creation returns epic and step IDs
      mockWorkflow.startWorkflow.mockResolvedValue({
        epicId: "bd-w001",
        stepId: "bd-w001.1",
      });

      // Agent runs successfully and produces handoff
      mockAgentRunnerInstance.run.mockResolvedValue({
        sessionId: "session-123",
        output: "Done! PR created.",
        costUsd: 0.05,
      });

      // Handoff to quality_review
      mockHandoff.getHandoff.mockResolvedValue({
        next_agent: "quality_review",
        pr_number: 42,
        ci_status: "pending",
        context: "Implementation complete. PR #42 ready for review.",
      });

      const dispatcher = new Dispatcher(testConfig, mockNotifier);
      // Set running flag so tick() will process work
      (dispatcher as any).running = true;

      // Run one tick (don't start the loop)
      await (dispatcher as any).tick();
      // Wait for async agent dispatch to complete
      await flushPromises();

      // Verify workflow was created
      expect(mockWorkflow.startWorkflow).toHaveBeenCalledWith(
        "test-project",
        expect.objectContaining({ id: "bd-123" }),
        "implementation"
      );

      // Verify worktree was created
      expect(mockWorktree.ensureWorktree).toHaveBeenCalledWith(
        "test-project",
        "bd-123",
        { baseBranch: "main" }
      );

      // Verify agent was run
      expect(mockAgentRunnerInstance.run).toHaveBeenCalled();

      // Verify handoff was processed
      expect(mockWorkflow.completeStep).toHaveBeenCalledWith(
        "bd-w001.1",
        "Implementation complete. PR #42 ready for review."
      );

      // Verify next step was created
      expect(mockWorkflow.createNextStep).toHaveBeenCalledWith(
        "bd-w001",
        "quality_review",
        "Implementation complete. PR #42 ready for review.",
        { pr_number: 42, ci_status: "pending" }
      );

      // Verify notifier was called
      expect(mockNotifier.notifyProgress).toHaveBeenCalled();
    });

    it("completes workflow on DONE handoff", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      mockBeads.ready.mockReturnValue([testBead]);
      mockWorkflow.startWorkflow.mockResolvedValue({
        epicId: "bd-w001",
        stepId: "bd-w001.1",
      });

      // Need to provide source bead info for closing the source bead
      mockWorkflow.getSourceBeadInfo.mockReturnValue({
        project: "test-project",
        beadId: "bd-123",
      });

      mockAgentRunnerInstance.run.mockResolvedValue({
        sessionId: "session-123",
        output: "All done!",
        costUsd: 0.05,
      });

      // DONE handoff
      mockHandoff.getHandoff.mockResolvedValue({
        next_agent: "DONE",
        pr_number: 42,
        ci_status: "passed",
        context: "PR merged successfully.",
      });

      const dispatcher = new Dispatcher(testConfig, mockNotifier);
      (dispatcher as any).running = true;
      await (dispatcher as any).tick();
      await flushPromises();

      // Verify workflow was completed
      expect(mockWorkflow.completeWorkflow).toHaveBeenCalledWith(
        "bd-w001",
        "done",
        "PR merged successfully."
      );

      // Verify source bead was closed
      expect(mockBeads.close).toHaveBeenCalledWith(
        "bd-123",
        "Completed by WHS workflow",
        "/home/user/work/test-project"
      );

      // Verify notifier was called
      expect(mockNotifier.notifyComplete).toHaveBeenCalledWith(
        expect.any(Object),
        "done"
      );
    });

    it("marks workflow blocked on BLOCKED handoff", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      mockBeads.ready.mockReturnValue([testBead]);
      mockWorkflow.startWorkflow.mockResolvedValue({
        epicId: "bd-w001",
        stepId: "bd-w001.1",
      });

      mockAgentRunnerInstance.run.mockResolvedValue({
        sessionId: "session-123",
        output: "Need human input.",
        costUsd: 0.05,
      });

      // BLOCKED handoff
      mockHandoff.getHandoff.mockResolvedValue({
        next_agent: "BLOCKED",
        context: "Need clarification on auth requirements.",
      });

      const dispatcher = new Dispatcher(testConfig, mockNotifier);
      (dispatcher as any).running = true;
      await (dispatcher as any).tick();
      await flushPromises();

      // Verify workflow was marked blocked
      expect(mockWorkflow.completeWorkflow).toHaveBeenCalledWith(
        "bd-w001",
        "blocked",
        "Need clarification on auth requirements."
      );

      expect(mockNotifier.notifyComplete).toHaveBeenCalledWith(
        expect.any(Object),
        "blocked"
      );
    });
  });

  describe("Workflow: Multi-step handoffs", () => {
    it("dispatches ready workflow steps from orchestrator", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      // No new work in projects
      mockBeads.ready.mockReturnValue([]);

      // But there's a ready step in the orchestrator
      mockWorkflow.getReadyWorkflowSteps.mockReturnValue([
        {
          id: "bd-w001.2",
          epicId: "bd-w001",
          agent: "quality_review",
          context: "Review PR #42",
          status: "open",
        },
      ]);

      // Return the parent epic when looking up the step
      mockWorkflow.getWorkflowEpic.mockReturnValue({
        id: "bd-w001",
        title: "test-project:bd-123 - Test task",
        labels: ["project:test-project", "source:bd-123"],
      });

      // Source info from the epic
      mockWorkflow.getSourceBeadInfo.mockReturnValue({
        project: "test-project",
        beadId: "bd-123",
      });

      mockAgentRunnerInstance.run.mockResolvedValue({
        sessionId: "session-456",
        output: "Approved!",
        costUsd: 0.03,
      });

      mockHandoff.getHandoff.mockResolvedValue({
        next_agent: "release_manager",
        pr_number: 42,
        ci_status: "passed",
        context: "PR approved, ready to merge.",
      });

      const dispatcher = new Dispatcher(testConfig, mockNotifier);
      (dispatcher as any).running = true;
      await (dispatcher as any).tick();
      await flushPromises();

      // Verify step was marked in progress
      expect(mockWorkflow.markStepInProgress).toHaveBeenCalledWith("bd-w001.2");

      // Verify agent was run
      expect(mockAgentRunnerInstance.run).toHaveBeenCalled();

      // Verify next step was created
      expect(mockWorkflow.createNextStep).toHaveBeenCalledWith(
        "bd-w001",
        "release_manager",
        "PR approved, ready to merge.",
        { pr_number: 42, ci_status: "passed" }
      );
    });
  });

  describe("Workflow: Question handling", () => {
    it("pauses workflow and notifies on pending question", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      // Reset mocks that may leak from previous tests
      mockWorkflow.getReadyWorkflowSteps.mockReturnValue([]);
      mockWorkflow.getSourceBeadInfo.mockReturnValue(null);

      mockBeads.ready.mockReturnValue([testBead]);
      mockWorkflow.startWorkflow.mockResolvedValue({
        epicId: "bd-w001",
        stepId: "bd-w001.1",
      });

      // Agent asks a question
      mockAgentRunnerInstance.run.mockResolvedValue({
        sessionId: "session-123",
        output: "Need input",
        costUsd: 0.02,
        pendingQuestion: {
          questions: [
            {
              question: "Which auth provider?",
              header: "Auth",
              options: [
                { label: "JWT", description: "JSON Web Tokens" },
                { label: "OAuth", description: "OAuth 2.0" },
              ],
              multiSelect: false,
            },
          ],
          context: "Need to choose auth provider.",
        },
      });

      const dispatcher = new Dispatcher(testConfig, mockNotifier);
      (dispatcher as any).running = true;
      await (dispatcher as any).tick();
      await flushPromises();

      // Verify question bead was created
      expect(mockBeads.createQuestion).toHaveBeenCalledWith(
        expect.stringContaining("Question:"),
        expect.any(String), // orchestratorPath
        expect.objectContaining({
          questions: expect.arrayContaining([
            expect.objectContaining({ question: "Which auth provider?" }),
          ]),
        }),
        "bd-w001", // epicId
        "bd-w001.1" // stepId
      );

      // Verify work was removed from active (paused)
      expect(mockState.removeActiveWork).toHaveBeenCalled();

      // Verify notifier was called
      expect(mockNotifier.notifyQuestion).toHaveBeenCalled();
    });
  });

  describe("Error handling", () => {
    it("pauses on rate limit error", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      mockBeads.ready.mockReturnValue([testBead]);
      mockWorkflow.startWorkflow.mockResolvedValue({
        epicId: "bd-w001",
        stepId: "bd-w001.1",
      });

      // Agent throws rate limit error
      mockAgentRunnerInstance.run.mockRejectedValue(new Error("Rate limit exceeded (429)"));

      const dispatcher = new Dispatcher(testConfig, mockNotifier);
      (dispatcher as any).running = true;
      await (dispatcher as any).tick();
      await flushPromises();

      // Verify dispatcher was paused
      expect(mockState.setPaused).toHaveBeenCalledWith(expect.any(Object), true);

      // Verify notifier was called
      expect(mockNotifier.notifyRateLimit).toHaveBeenCalled();
    });

    it("marks workflow blocked on agent error", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      mockBeads.ready.mockReturnValue([testBead]);
      mockWorkflow.startWorkflow.mockResolvedValue({
        epicId: "bd-w001",
        stepId: "bd-w001.1",
      });

      // Agent throws generic error
      mockAgentRunnerInstance.run.mockRejectedValue(new Error("Something went wrong"));

      const dispatcher = new Dispatcher(testConfig, mockNotifier);
      (dispatcher as any).running = true;
      await (dispatcher as any).tick();
      await flushPromises();

      // Verify workflow was marked blocked
      expect(mockWorkflow.completeWorkflow).toHaveBeenCalledWith(
        "bd-w001",
        "blocked",
        expect.stringContaining("Agent error")
      );

      // Verify notifier was called
      expect(mockNotifier.notifyError).toHaveBeenCalled();
    });

    it("handles invalid next_agent by marking blocked", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      mockBeads.ready.mockReturnValue([testBead]);
      mockWorkflow.startWorkflow.mockResolvedValue({
        epicId: "bd-w001",
        stepId: "bd-w001.1",
      });

      mockAgentRunnerInstance.run.mockResolvedValue({
        sessionId: "session-123",
        output: "Done",
        costUsd: 0.05,
      });

      // Invalid agent in handoff
      mockHandoff.getHandoff.mockResolvedValue({
        next_agent: "invalid_agent",
        context: "Some context",
      });
      mockHandoff.isValidAgent.mockReturnValue(false);

      const dispatcher = new Dispatcher(testConfig, mockNotifier);
      (dispatcher as any).running = true;
      await (dispatcher as any).tick();
      await flushPromises();

      // Verify workflow was marked blocked
      expect(mockWorkflow.completeWorkflow).toHaveBeenCalledWith(
        "bd-w001",
        "blocked",
        expect.stringContaining("Invalid agent")
      );
    });
  });

  describe("Concurrency limits", () => {
    it("respects maxTotal concurrency limit", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      // Config with limit of 2
      const limitedConfig: Config = {
        ...testConfig,
        concurrency: { maxTotal: 2, maxPerProject: 2 },
      };

      // Multiple beads ready
      mockBeads.ready.mockReturnValue([
        { ...testBead, id: "bd-1" },
        { ...testBead, id: "bd-2" },
        { ...testBead, id: "bd-3" },
      ]);

      mockWorkflow.startWorkflow.mockResolvedValue({
        epicId: "bd-w001",
        stepId: "bd-w001.1",
      });

      // Don't resolve agent runs (simulates long-running)
      mockAgentRunnerInstance.run.mockReturnValue(new Promise(() => {}));

      const dispatcher = new Dispatcher(limitedConfig, mockNotifier);

      // Manually set active work to simulate at capacity
      (dispatcher as any).state.activeWork.set("bd-1", {});
      (dispatcher as any).state.activeWork.set("bd-2", {});

      await (dispatcher as any).tick();
      await flushPromises();

      // Should not start new workflow when at capacity
      expect(mockWorkflow.startWorkflow).not.toHaveBeenCalled();
    });

    it("respects maxPerProject concurrency limit", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      // Config with per-project limit of 1
      const limitedConfig: Config = {
        ...testConfig,
        concurrency: { maxTotal: 4, maxPerProject: 1 },
      };

      // Multiple beads ready
      mockBeads.ready.mockReturnValue([
        { ...testBead, id: "bd-1" },
        { ...testBead, id: "bd-2" },
      ]);

      mockWorkflow.startWorkflow.mockResolvedValue({
        epicId: "bd-w001",
        stepId: "bd-w001.1",
      });

      mockAgentRunnerInstance.run.mockReturnValue(new Promise(() => {}));

      const dispatcher = new Dispatcher(limitedConfig, mockNotifier);

      // Set one active work for test-project
      (dispatcher as any).state.activeWork.set("bd-1", {
        workItem: { project: "test-project" },
      });

      await (dispatcher as any).tick();
      await flushPromises();

      // Should not start new workflow for same project
      expect(mockWorkflow.startWorkflow).not.toHaveBeenCalled();
    });

    it("respects maxPerProject for workflow steps", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      // Config with per-project limit of 1
      const limitedConfig: Config = {
        ...testConfig,
        concurrency: { maxTotal: 4, maxPerProject: 1 },
      };

      // Orchestrator has two ready workflow steps for the same project
      mockWorkflow.getReadyWorkflowSteps.mockReturnValue([
        {
          id: "bd-w001.2",
          epicId: "bd-w001",
          agent: "quality_review",
          context: "PR ready for review",
          status: "open",
        },
        {
          id: "bd-w002.1",
          epicId: "bd-w002",
          agent: "implementation",
          context: "New task",
          status: "open",
        },
      ]);

      // Both epics belong to the same project
      mockWorkflow.getSourceBeadInfo
        .mockReturnValueOnce({ project: "test-project", beadId: "bd-100" })
        .mockReturnValueOnce({ project: "test-project", beadId: "bd-200" });

      // No project beads ready (we're testing workflow step dispatch only)
      mockBeads.ready.mockReturnValue([]);

      mockAgentRunnerInstance.run.mockReturnValue(new Promise(() => {}));

      // Mock what dispatchWorkflowStep needs
      mockWorkflow.getWorkflowEpic.mockReturnValue({
        id: "bd-w001",
        labels: ["project:test-project", "source:bd-100"],
      });
      mockWorkflow.getWorkflowContext.mockReturnValue("context");

      const dispatcher = new Dispatcher(limitedConfig, mockNotifier);
      (dispatcher as any).running = true;
      await (dispatcher as any).tick();
      await flushPromises();

      // Should dispatch only the first step, skip the second due to maxPerProject
      expect(mockWorkflow.markStepInProgress).toHaveBeenCalledTimes(1);
      expect(mockWorkflow.markStepInProgress).toHaveBeenCalledWith("bd-w001.2");
    });
  });

  describe("Dispatcher lifecycle", () => {
    it("can be paused and resumed", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      const dispatcher = new Dispatcher(testConfig, mockNotifier);

      dispatcher.pause();
      expect(mockState.setPaused).toHaveBeenCalledWith(expect.any(Object), true);

      dispatcher.resume();
      expect(mockState.setPaused).toHaveBeenCalledWith(expect.any(Object), false);
    });

    it("provides status information", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      const dispatcher = new Dispatcher(testConfig, mockNotifier);

      const status = dispatcher.getStatus();

      expect(status).toEqual({
        active: [],
        pendingQuestionCount: 0,
        paused: false,
      });
    });
  });

  describe("Skip existing workflows", () => {
    it("skips beads that already have workflows", async () => {
      const { Dispatcher } = await import("./dispatcher.js");

      mockBeads.ready.mockReturnValue([testBead]);

      // Workflow already exists for this bead
      mockWorkflow.getWorkflowForSource.mockReturnValue({
        id: "bd-w001",
        status: "in_progress",
      });

      const dispatcher = new Dispatcher(testConfig, mockNotifier);
      await (dispatcher as any).tick();
      await flushPromises();

      // Should not create new workflow
      expect(mockWorkflow.startWorkflow).not.toHaveBeenCalled();
    });
  });
});

describe("Agent role mapping", () => {
  it("maps agent names to role descriptions", async () => {
    vi.clearAllMocks();
    const { Dispatcher } = await import("./dispatcher.js");

    const mockNotifier: Notifier = {
      notifyQuestion: vi.fn(),
      notifyProgress: vi.fn(),
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      notifyRateLimit: vi.fn(),
    };

    const config: Config = {
      projects: [],
      orchestratorPath: "/test",
      concurrency: { maxTotal: 4, maxPerProject: 2 },
      notifier: "cli",
      runnerType: "cli",
    };

    const dispatcher = new Dispatcher(config, mockNotifier);

    // Test role mapping
    const getAgentRole = (dispatcher as any).getAgentRole.bind(dispatcher);

    expect(getAgentRole("implementation")).toContain("senior software engineer");
    expect(getAgentRole("quality_review")).toContain("code reviewer");
    expect(getAgentRole("release_manager")).toContain("release manager");
    expect(getAgentRole("ux_specialist")).toContain("UX specialist");
    expect(getAgentRole("architect")).toContain("software architect");
    expect(getAgentRole("planner")).toContain("technical planner");
    expect(getAgentRole("unknown_agent")).toContain("unknown_agent agent");
  });
});

// ============================================================
// Graceful Shutdown Tests
// ============================================================

describe("Graceful shutdown", () => {
  let mockNotifier: Notifier;
  let mockState: any;

  const testConfig: Config = {
    projects: [],
    orchestratorPath: "/test",
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
      runnerType: "cli",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockState = await import("./state.js");

    mockNotifier = {
      notifyQuestion: vi.fn(),
      notifyProgress: vi.fn(),
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      notifyRateLimit: vi.fn(),
    };
  });

  it("isAcceptingWork returns true when running and not shutting down", async () => {
    const { Dispatcher } = await import("./dispatcher.js");
    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    // Set running state manually (normally set by start())
    (dispatcher as any).running = true;
    (dispatcher as any).shuttingDown = false;

    expect(dispatcher.isAcceptingWork()).toBe(true);
  });

  it("isAcceptingWork returns false when shutting down", async () => {
    const { Dispatcher } = await import("./dispatcher.js");
    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    (dispatcher as any).running = true;
    (dispatcher as any).shuttingDown = true;

    expect(dispatcher.isAcceptingWork()).toBe(false);
  });

  it("isAcceptingWork returns false when not running", async () => {
    const { Dispatcher } = await import("./dispatcher.js");
    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    (dispatcher as any).running = false;
    (dispatcher as any).shuttingDown = false;

    expect(dispatcher.isAcceptingWork()).toBe(false);
  });

  it("getRunningAgentCount returns correct count", async () => {
    const { Dispatcher } = await import("./dispatcher.js");
    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    expect(dispatcher.getRunningAgentCount()).toBe(0);

    // Simulate adding running agents
    const runningAgents = (dispatcher as any).runningAgents;
    runningAgents.set("agent-1", Promise.resolve());
    runningAgents.set("agent-2", Promise.resolve());

    expect(dispatcher.getRunningAgentCount()).toBe(2);
  });

  it("requestShutdown stops immediately when no agents running", async () => {
    const { Dispatcher } = await import("./dispatcher.js");
    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    (dispatcher as any).running = true;
    (dispatcher as any).shuttingDown = false;

    await dispatcher.requestShutdown();

    expect((dispatcher as any).running).toBe(false);
    expect(mockState.saveState).toHaveBeenCalled();
    expect(mockState.releaseLock).toHaveBeenCalled();
  });

  it("requestShutdown waits for running agents", async () => {
    const { Dispatcher } = await import("./dispatcher.js");
    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    (dispatcher as any).running = true;

    // Create a promise that we can resolve manually
    let resolveAgent!: () => void;
    const agentPromise = new Promise<void>((resolve) => {
      resolveAgent = resolve;
    });

    // Add running agent
    (dispatcher as any).runningAgents.set("agent-1", agentPromise);

    // Start shutdown (don't await yet)
    const shutdownPromise = dispatcher.requestShutdown();

    // Verify still shutting down (shuttingDown flag set)
    expect((dispatcher as any).shuttingDown).toBe(true);
    expect((dispatcher as any).running).toBe(true);

    // Complete the agent
    resolveAgent();
    await shutdownPromise;

    // Now should be stopped
    expect((dispatcher as any).running).toBe(false);
  });

  it("double requestShutdown forces immediate stop", async () => {
    const { Dispatcher } = await import("./dispatcher.js");
    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    (dispatcher as any).running = true;

    // Create a never-resolving promise (simulates long-running agent)
    const neverResolves = new Promise<void>(() => {});
    (dispatcher as any).runningAgents.set("agent-1", neverResolves);

    // First shutdown starts graceful wait
    const shutdownPromise = dispatcher.requestShutdown();

    expect((dispatcher as any).shuttingDown).toBe(true);
    expect((dispatcher as any).running).toBe(true);

    // Second shutdown forces stop
    await dispatcher.requestShutdown();

    expect((dispatcher as any).running).toBe(false);
  });

  it("tick does not start new work when shutting down", async () => {
    const { Dispatcher } = await import("./dispatcher.js");
    const mockWorkflow = await import("./workflow.js");
    const mockBeads = (await import("./beads/index.js")).beads as any;

    mockBeads.ready.mockReturnValue([{
      id: "bd-123",
      title: "Test task",
      status: "open",
      priority: 1,
    }]);

    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    (dispatcher as any).running = true;
    (dispatcher as any).shuttingDown = true;

    await (dispatcher as any).tick();

    // Should not start new workflows when shutting down
    expect(mockWorkflow.startWorkflow).not.toHaveBeenCalled();
  });

  it("stop() calls requestShutdown", async () => {
    const { Dispatcher } = await import("./dispatcher.js");
    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    const requestShutdownSpy = vi.spyOn(dispatcher, "requestShutdown");

    await dispatcher.stop();

    expect(requestShutdownSpy).toHaveBeenCalled();
  });
});

// ============================================================
// Lock File Tests for Dispatcher
// ============================================================

describe("Dispatcher lock file", () => {
  let mockNotifier: Notifier;
  let mockState: any;

  const testConfig: Config = {
    projects: [],
    orchestratorPath: "/test",
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
      runnerType: "cli",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockState = await import("./state.js");

    mockNotifier = {
      notifyQuestion: vi.fn(),
      notifyProgress: vi.fn(),
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      notifyRateLimit: vi.fn(),
    };
  });

  it("start throws if another dispatcher is running", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    // Simulate existing lock
    mockState.getLockInfo.mockReturnValue({
      pid: 12345,
      startedAt: new Date().toISOString(),
    });

    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    await expect(dispatcher.start()).rejects.toThrow("Dispatcher already running");
  });

  it("start throws if lock acquisition fails", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockState.getLockInfo.mockReturnValue(null);
    mockState.acquireLock.mockReturnValue(false);

    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    await expect(dispatcher.start()).rejects.toThrow("Failed to acquire lock");
  });
});

// ============================================================
// Race Condition & Zombie Detection Tests
// ============================================================

describe("Dispatch race condition prevention", () => {
  let mockBeads: any;
  let mockWorkflow: any;
  let mockState: any;
  let mockNotifier: Notifier;

  const testConfig: Config = {
    projects: [
      {
        name: "test-project",
        repoPath: "/home/user/work/test-project",
        baseBranch: "main",
        agentsPath: "docs/llm/agents",
        beadsMode: "committed",
      },
    ],
    orchestratorPath: "/home/user/work/whs-orchestrator",
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
    runnerType: "cli",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBeads = (await import("./beads/index.js")).beads;
    mockWorkflow = await import("./workflow.js");
    mockState = await import("./state.js");

    mockNotifier = {
      notifyQuestion: vi.fn(),
      notifyProgress: vi.fn(),
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      notifyRateLimit: vi.fn(),
    };
  });

  it("does not dispatch same step twice when runningAgents has it", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockBeads.ready.mockReturnValue([]);
    mockWorkflow.getReadyWorkflowSteps.mockReturnValue([
      {
        id: "bd-w001.1",
        epicId: "bd-w001",
        agent: "implementation",
        context: "Work",
        status: "open",
      },
    ]);

    mockWorkflow.getWorkflowEpic.mockReturnValue({
      id: "bd-w001",
      labels: ["project:test-project", "source:bd-123"],
    });
    mockWorkflow.getSourceBeadInfo.mockReturnValue({
      project: "test-project",
      beadId: "bd-123",
    });

    // Agent never resolves (simulates long-running)
    mockAgentRunnerInstance.run.mockReturnValue(new Promise(() => {}));

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;

    // First tick dispatches the step
    await (dispatcher as any).tick();
    await flushPromises();

    expect(mockWorkflow.markStepInProgress).toHaveBeenCalledTimes(1);
    expect(mockAgentRunnerInstance.run).toHaveBeenCalledTimes(1);

    // Step is still in runningAgents (agent hasn't finished)
    expect((dispatcher as any).runningAgents.has("bd-w001.1")).toBe(true);

    // Reset mocks but keep runningAgents state
    mockWorkflow.markStepInProgress.mockClear();
    mockAgentRunnerInstance.run.mockClear();

    // Second tick should skip it due to runningAgents guard
    await (dispatcher as any).tick();
    await flushPromises();

    expect(mockWorkflow.markStepInProgress).not.toHaveBeenCalled();
    expect(mockAgentRunnerInstance.run).not.toHaveBeenCalled();
  });

  it("marks step in_progress before async dispatch", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockBeads.ready.mockReturnValue([]);
    mockWorkflow.getReadyWorkflowSteps.mockReturnValue([
      {
        id: "bd-w001.1",
        epicId: "bd-w001",
        agent: "implementation",
        context: "Work",
        status: "open",
      },
    ]);

    mockWorkflow.getWorkflowEpic.mockReturnValue({
      id: "bd-w001",
      labels: ["project:test-project", "source:bd-123"],
    });
    mockWorkflow.getSourceBeadInfo.mockReturnValue({
      project: "test-project",
      beadId: "bd-123",
    });

    // Track call order
    const callOrder: string[] = [];
    mockWorkflow.markStepInProgress.mockImplementation(() => {
      callOrder.push("markStepInProgress");
    });
    mockAgentRunnerInstance.run.mockImplementation(() => {
      callOrder.push("agentRunner.run");
      return Promise.resolve({
        sessionId: "s-1",
        output: "Done",
        costUsd: 0.01,
      });
    });

    const { getHandoff } = await import("./handoff.js");
    (getHandoff as any).mockResolvedValue({
      next_agent: "DONE",
      context: "Complete",
    });
    mockWorkflow.getSourceBeadInfo.mockReturnValue({
      project: "test-project",
      beadId: "bd-123",
    });

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;
    await (dispatcher as any).tick();
    await flushPromises();

    // markStepInProgress should be called BEFORE agentRunner.run
    expect(callOrder[0]).toBe("markStepInProgress");
    expect(callOrder[1]).toBe("agentRunner.run");
  });

  it("skips step if markStepInProgress throws", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockBeads.ready.mockReturnValue([]);
    mockWorkflow.getReadyWorkflowSteps.mockReturnValue([
      {
        id: "bd-w001.1",
        epicId: "bd-w001",
        agent: "implementation",
        context: "Work",
        status: "open",
      },
    ]);

    // markStepInProgress throws (e.g. beads CLI error)
    mockWorkflow.markStepInProgress.mockImplementation(() => {
      throw new Error("bd: bead not found");
    });

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;
    await (dispatcher as any).tick();
    await flushPromises();

    // Agent should NOT have been run
    expect(mockAgentRunnerInstance.run).not.toHaveBeenCalled();
    // Step should NOT be in runningAgents
    expect((dispatcher as any).runningAgents.has("bd-w001.1")).toBe(false);
  });
});

describe("Zombie detection and reconciliation", () => {
  let mockWorkflow: any;
  let mockState: any;
  let mockNotifier: Notifier;

  const testConfig: Config = {
    projects: [
      {
        name: "test-project",
        repoPath: "/home/user/work/test-project",
        baseBranch: "main",
        agentsPath: "docs/llm/agents",
        beadsMode: "committed",
      },
    ],
    orchestratorPath: "/home/user/work/whs-orchestrator",
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
    runnerType: "cli",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const beadsModule = await import("./beads/index.js");
    (beadsModule.beads as any).ready.mockReturnValue([]);
    mockWorkflow = await import("./workflow.js");
    mockState = await import("./state.js");

    mockNotifier = {
      notifyQuestion: vi.fn(),
      notifyProgress: vi.fn(),
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      notifyRateLimit: vi.fn(),
    };
  });

  it("detects and cleans up zombie activeWork entries", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;

    // Simulate a zombie: in activeWork but NOT in runningAgents
    const zombieWork: ActiveWork = {
      workItem: {
        id: "bd-w001.1",
        project: "test-project",
        title: "implementation",
        description: "",
        priority: 2,
        type: "task",
        status: "in_progress",
        labels: [],
        dependencies: [],
      },
      workflowEpicId: "bd-w001",
      workflowStepId: "orc-abc.1",
      sessionId: "dead-session",
      worktreePath: "/tmp/worktree",
      startedAt: new Date(),
      agent: "implementation",
      costSoFar: 0.05,
    };

    (dispatcher as any).state.activeWork.set("bd-w001.1", zombieWork);
    // Note: NOT adding to runningAgents — this is the zombie condition

    await (dispatcher as any).tick();
    await flushPromises();

    // Zombie should be removed from activeWork
    expect(mockState.removeActiveWork).toHaveBeenCalledWith(
      expect.any(Object),
      "bd-w001.1"
    );

    // Step should be reset for retry
    expect(mockWorkflow.resetStepForRetry).toHaveBeenCalledWith("orc-abc.1", 3);
  });

  it("does not flag running agents as zombies", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;

    const activeWork: ActiveWork = {
      workItem: {
        id: "bd-w001.1",
        project: "test-project",
        title: "implementation",
        description: "",
        priority: 2,
        type: "task",
        status: "in_progress",
        labels: [],
        dependencies: [],
      },
      workflowEpicId: "bd-w001",
      workflowStepId: "orc-abc.1",
      sessionId: "active-session",
      worktreePath: "/tmp/worktree",
      startedAt: new Date(),
      agent: "implementation",
      costSoFar: 0,
    };

    (dispatcher as any).state.activeWork.set("bd-w001.1", activeWork);
    // This time, also add to runningAgents — NOT a zombie
    (dispatcher as any).runningAgents.set("bd-w001.1", new Promise(() => {}));

    await (dispatcher as any).tick();
    await flushPromises();

    // Should NOT be removed
    expect(mockState.removeActiveWork).not.toHaveBeenCalledWith(
      expect.any(Object),
      "bd-w001.1"
    );
    expect(mockWorkflow.resetStepForRetry).not.toHaveBeenCalled();
  });
});

describe("Circuit breaker on dispatch failure", () => {
  let mockBeads: any;
  let mockWorkflow: any;
  let mockState: any;
  let mockNotifier: Notifier;

  const testConfig: Config = {
    projects: [
      {
        name: "test-project",
        repoPath: "/home/user/work/test-project",
        baseBranch: "main",
        agentsPath: "docs/llm/agents",
        beadsMode: "committed",
      },
    ],
    orchestratorPath: "/home/user/work/whs-orchestrator",
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
    runnerType: "cli",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBeads = (await import("./beads/index.js")).beads;
    mockWorkflow = await import("./workflow.js");
    mockState = await import("./state.js");

    mockNotifier = {
      notifyQuestion: vi.fn(),
      notifyProgress: vi.fn(),
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      notifyRateLimit: vi.fn(),
    };
  });

  it("calls resetStepForRetry when dispatch throws", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockBeads.ready.mockReturnValue([]);
    // Ensure markStepInProgress doesn't throw (reset from previous tests)
    mockWorkflow.markStepInProgress.mockImplementation(() => {});
    mockWorkflow.getReadyWorkflowSteps.mockReturnValue([
      {
        id: "bd-w001.1",
        epicId: "bd-w001",
        agent: "implementation",
        context: "Work",
        status: "open",
      },
    ]);

    // Make getWorkflowEpic throw (simulates beads CLI failure)
    mockWorkflow.getWorkflowEpic.mockImplementation(() => {
      throw new Error("bd: command failed");
    });

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;
    await (dispatcher as any).tick();
    await flushPromises();

    // resetStepForRetry should have been called by the .catch handler
    expect(mockWorkflow.resetStepForRetry).toHaveBeenCalledWith("bd-w001.1", 3);
  });

  it("cleans up activeWork on agent error via handleAgentError", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockBeads.ready.mockReturnValue([]);
    // Ensure markStepInProgress doesn't throw (reset from previous tests)
    mockWorkflow.markStepInProgress.mockImplementation(() => {});
    mockWorkflow.getReadyWorkflowSteps.mockReturnValue([
      {
        id: "bd-w001.1",
        epicId: "bd-w001",
        agent: "implementation",
        context: "Work",
        status: "open",
      },
    ]);

    mockWorkflow.getWorkflowEpic.mockReturnValue({
      id: "bd-w001",
      labels: ["project:test-project", "source:bd-123"],
    });
    mockWorkflow.getSourceBeadInfo.mockReturnValue({
      project: "test-project",
      beadId: "bd-123",
    });

    // Agent run throws (non-rate-limit error)
    mockAgentRunnerInstance.run.mockRejectedValue(new Error("Agent crashed"));

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;
    await (dispatcher as any).tick();
    await flushPromises();

    // handleAgentError marks workflow blocked and removes from activeWork
    expect(mockWorkflow.completeWorkflow).toHaveBeenCalledWith(
      "bd-w001",
      "blocked",
      expect.stringContaining("Agent error")
    );
    expect(mockState.removeActiveWork).toHaveBeenCalled();
  });
});

// ============================================================
// Preflight Check Tests
// ============================================================

describe("Preflight check", () => {
  let mockState: any;
  let mockNotifier: Notifier;

  const testConfig: Config = {
    projects: [],
    orchestratorPath: "/test",
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
    runnerType: "cli",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockState = await import("./state.js");

    mockNotifier = {
      notifyQuestion: vi.fn(),
      notifyProgress: vi.fn(),
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      notifyRateLimit: vi.fn(),
    };
  });

  it("runPreflightCheck succeeds on valid auth", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockAgentRunnerInstance.run.mockResolvedValue({
      sessionId: "preflight-session",
      output: "PREFLIGHT_OK",
      costUsd: 0.001,
      turns: 1,
      durationMs: 500,
      success: true,
    });

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    await expect(dispatcher.runPreflightCheck()).resolves.toBeUndefined();

    expect(mockAgentRunnerInstance.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Respond with exactly: PREFLIGHT_OK",
        maxTurns: 1,
      })
    );
  });

  it("runPreflightCheck throws on auth failure", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockAgentRunnerInstance.run.mockResolvedValue({
      sessionId: "",
      output: "",
      costUsd: 0,
      turns: 0,
      durationMs: 100,
      success: false,
      isAuthError: true,
      error: "OAuth token expired",
    });

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    await expect(dispatcher.runPreflightCheck()).rejects.toThrow("Authentication failed");
  });

  it("runPreflightCheck throws on generic failure", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockAgentRunnerInstance.run.mockResolvedValue({
      sessionId: "",
      output: "",
      costUsd: 0,
      turns: 0,
      durationMs: 100,
      success: false,
      error: "Connection refused",
    });

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    await expect(dispatcher.runPreflightCheck()).rejects.toThrow("Preflight check failed");
  });

  it("runPreflightCheck throws when agent runner throws", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockAgentRunnerInstance.run.mockRejectedValue(new Error("Network timeout"));

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    await expect(dispatcher.runPreflightCheck()).rejects.toThrow("Network timeout");
  });

  it("start() releases lock on preflight failure", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockState.getLockInfo.mockReturnValue(null);
    mockState.acquireLock.mockReturnValue(true);

    mockAgentRunnerInstance.run.mockResolvedValue({
      sessionId: "",
      output: "",
      costUsd: 0,
      turns: 0,
      durationMs: 100,
      success: false,
      isAuthError: true,
      error: "OAuth token expired",
    });

    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    await expect(dispatcher.start()).rejects.toThrow("Authentication failed");
    expect(mockState.releaseLock).toHaveBeenCalled();
  });

  it("resume sets preflightNeeded flag", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    dispatcher.resume();

    expect((dispatcher as any).preflightNeeded).toBe(true);
    expect(mockState.setPaused).toHaveBeenCalledWith(expect.any(Object), false);
  });
});

// ============================================================
// Errored Workflow Recovery Tests
// ============================================================

describe("Errored workflow recovery", () => {
  let mockWorkflow: any;
  let mockState: any;
  let mockNotifier: Notifier;

  const testConfig: Config = {
    projects: [
      {
        name: "test-project",
        repoPath: "/home/user/work/test-project",
        baseBranch: "main",
        agentsPath: "docs/llm/agents",
        beadsMode: "committed",
      },
    ],
    orchestratorPath: "/home/user/work/whs-orchestrator",
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
    runnerType: "cli",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const beadsModule = await import("./beads/index.js");
    (beadsModule.beads as any).ready.mockReturnValue([]);
    (beadsModule.beads as any).listPendingQuestions.mockReturnValue([]);
    mockWorkflow = await import("./workflow.js");
    mockState = await import("./state.js");

    mockNotifier = {
      notifyQuestion: vi.fn(),
      notifyProgress: vi.fn(),
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      notifyRateLimit: vi.fn(),
    };
  });

  it("handleAuthError marks workflow as errored, not blocked", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    const mockBeads = (await import("./beads/index.js")).beads as any;
    mockBeads.ready.mockReturnValue([{
      id: "bd-123",
      title: "Test task",
      description: "Test",
      priority: 1,
      type: "task",
      status: "open",
      labels: [],
      dependencies: [],
    }]);

    mockWorkflow.startWorkflow.mockResolvedValue({
      epicId: "bd-w001",
      stepId: "bd-w001.1",
    });

    // Agent returns auth error
    mockAgentRunnerInstance.run.mockResolvedValue({
      sessionId: "session-123",
      output: "",
      costUsd: 0,
      turns: 0,
      success: false,
      isAuthError: true,
      error: "OAuth token expired",
    });

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;
    await (dispatcher as any).tick();
    await flushPromises();

    // Should call errorWorkflow (not completeWorkflow with "blocked")
    expect(mockWorkflow.errorWorkflow).toHaveBeenCalledWith(
      "bd-w001",
      expect.stringContaining("Authentication error"),
      "auth"
    );

    // Should NOT call completeWorkflow with "blocked"
    expect(mockWorkflow.completeWorkflow).not.toHaveBeenCalledWith(
      "bd-w001",
      "blocked",
      expect.any(String)
    );

    // Should notify error
    expect(mockNotifier.notifyError).toHaveBeenCalled();
  });

  it("recoverErroredWorkflows resets errored workflows", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockWorkflow.getErroredWorkflows.mockReturnValue([
      {
        epicId: "bd-w001",
        errorType: "auth",
        reason: "Auth failed",
        sourceProject: "test-project",
        sourceBeadId: "bd-123",
      },
      {
        epicId: "bd-w002",
        errorType: "auth",
        reason: "Auth failed",
        sourceProject: "test-project",
        sourceBeadId: "bd-456",
      },
    ]);

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).recoverErroredWorkflows();

    expect(mockWorkflow.retryWorkflow).toHaveBeenCalledTimes(2);
    expect(mockWorkflow.retryWorkflow).toHaveBeenCalledWith("bd-w001");
    expect(mockWorkflow.retryWorkflow).toHaveBeenCalledWith("bd-w002");
  });

  it("recoverErroredWorkflows is called after preflight on start", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockState.getLockInfo.mockReturnValue(null);
    mockState.acquireLock.mockReturnValue(true);

    // Preflight succeeds
    mockAgentRunnerInstance.run.mockResolvedValue({
      sessionId: "preflight",
      output: "PREFLIGHT_OK",
      costUsd: 0.001,
      turns: 1,
      success: true,
    });

    // One errored workflow to recover
    mockWorkflow.getErroredWorkflows.mockReturnValue([
      {
        epicId: "bd-w001",
        errorType: "auth",
        reason: "Auth failed",
        sourceProject: "test-project",
        sourceBeadId: "bd-123",
      },
    ]);

    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    // Spy on recoverErroredWorkflows and stop the loop immediately
    const recoverSpy = vi.spyOn(dispatcher as any, "recoverErroredWorkflows");
    const originalSleep = (dispatcher as any).sleep.bind(dispatcher);
    (dispatcher as any).sleep = async () => {
      // Stop the loop on first sleep (after preflight + recovery, before first tick)
      (dispatcher as any).running = false;
    };

    await dispatcher.start();

    // recoverErroredWorkflows should have been called after preflight
    expect(recoverSpy).toHaveBeenCalled();
    expect(mockWorkflow.retryWorkflow).toHaveBeenCalledWith("bd-w001");
  });

  it("retryWorkflow resets epic and step status", async () => {
    // This is tested in workflow.test.ts, but verify the integration:
    // dispatcher's recoverErroredWorkflows calls retryWorkflow for each errored workflow
    const { Dispatcher } = await import("./dispatcher.js");

    mockWorkflow.getErroredWorkflows.mockReturnValue([
      {
        epicId: "bd-w001",
        errorType: "auth",
        reason: "Auth failed",
        sourceProject: "test-project",
        sourceBeadId: "bd-123",
      },
    ]);

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).recoverErroredWorkflows();

    expect(mockWorkflow.retryWorkflow).toHaveBeenCalledWith("bd-w001");
  });

  it("recoverErroredWorkflows handles retryWorkflow errors gracefully", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockWorkflow.getErroredWorkflows.mockReturnValue([
      {
        epicId: "bd-w001",
        errorType: "auth",
        reason: "Auth failed",
        sourceProject: "test-project",
        sourceBeadId: "bd-123",
      },
    ]);

    mockWorkflow.retryWorkflow.mockImplementation(() => {
      throw new Error("beads CLI failed");
    });

    const dispatcher = new Dispatcher(testConfig, mockNotifier);

    // Should not throw
    expect(() => (dispatcher as any).recoverErroredWorkflows()).not.toThrow();
  });

  it("recoverErroredWorkflows does nothing when no errored workflows", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockWorkflow.getErroredWorkflows.mockReturnValue([]);

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).recoverErroredWorkflows();

    expect(mockWorkflow.retryWorkflow).not.toHaveBeenCalled();
  });
});

// ============================================================
// PR Feedback Routing Tests
// ============================================================

describe("PR feedback routing on first CI pass", () => {
  let mockBeads: any;
  let mockWorkflow: any;
  let mockNotifier: Notifier;

  const testConfig: Config = {
    projects: [
      {
        name: "test-project",
        repoPath: "/home/user/work/test-project",
        baseBranch: "main",
        agentsPath: "docs/llm/agents",
        beadsMode: "committed",
      },
    ],
    orchestratorPath: "/home/user/work/whs-orchestrator",
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
    runnerType: "cli",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBeads = (await import("./beads/index.js")).beads;
    mockWorkflow = await import("./workflow.js");

    mockNotifier = {
      notifyQuestion: vi.fn(),
      notifyProgress: vi.fn(),
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      notifyRateLimit: vi.fn(),
    };
  });

  it("redirects first CI pass for quality_review to implementation for PR feedback", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    // A quality_review step is waiting for CI
    mockWorkflow.getStepsPendingCI.mockReturnValue([
      {
        id: "bd-w001.2",
        epicId: "bd-w001",
        prNumber: 42,
        retryCount: 0,
        agent: "quality_review",
      },
    ]);

    // Epic does NOT have pr-feedback:addressed label (first CI pass)
    mockWorkflow.epicHasLabel.mockReturnValue(false);

    // No other ready steps or project beads
    mockWorkflow.getReadyWorkflowSteps.mockReturnValue([]);
    mockBeads.ready.mockReturnValue([]);

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;

    // Mock getGitHubCIStatus to return "passed"
    (dispatcher as any).getGitHubCIStatus = vi.fn(() => "passed");

    await (dispatcher as any).tick();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should check the epic label
    expect(mockWorkflow.epicHasLabel).toHaveBeenCalledWith("bd-w001", "pr-feedback:addressed");

    // Should update CI status
    expect(mockWorkflow.updateStepCIStatus).toHaveBeenCalledWith("bd-w001.2", "passed", 0);

    // Should complete the current step
    expect(mockWorkflow.completeStep).toHaveBeenCalledWith(
      "bd-w001.2",
      "Redirected to implementation for PR feedback review"
    );

    // Should create a new implementation step
    expect(mockWorkflow.createNextStep).toHaveBeenCalledWith(
      "bd-w001",
      "implementation",
      expect.stringContaining("CI passed for PR #42"),
      { pr_number: 42, ci_status: "passed" }
    );

    // Should add the pr-feedback:addressed label
    expect(mockWorkflow.addEpicLabel).toHaveBeenCalledWith("bd-w001", "pr-feedback:addressed");
  });

  it("unblocks quality_review normally on second CI pass (label present)", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockWorkflow.getStepsPendingCI.mockReturnValue([
      {
        id: "bd-w001.4",
        epicId: "bd-w001",
        prNumber: 42,
        retryCount: 0,
        agent: "quality_review",
      },
    ]);

    // Epic already HAS the pr-feedback:addressed label (second CI pass)
    mockWorkflow.epicHasLabel.mockReturnValue(true);

    mockWorkflow.getReadyWorkflowSteps.mockReturnValue([]);
    mockBeads.ready.mockReturnValue([]);

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;
    (dispatcher as any).getGitHubCIStatus = vi.fn(() => "passed");

    await (dispatcher as any).tick();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should update CI status normally
    expect(mockWorkflow.updateStepCIStatus).toHaveBeenCalledWith("bd-w001.4", "passed", 0);

    // Should NOT create a new step or complete the current one
    expect(mockWorkflow.completeStep).not.toHaveBeenCalled();
    expect(mockWorkflow.createNextStep).not.toHaveBeenCalled();
    expect(mockWorkflow.addEpicLabel).not.toHaveBeenCalled();
  });

  it("does not redirect non-quality_review steps regardless of label", async () => {
    const { Dispatcher } = await import("./dispatcher.js");

    mockWorkflow.getStepsPendingCI.mockReturnValue([
      {
        id: "bd-w001.3",
        epicId: "bd-w001",
        prNumber: 42,
        retryCount: 0,
        agent: "implementation",
      },
    ]);

    // Epic does NOT have the label
    mockWorkflow.epicHasLabel.mockReturnValue(false);

    mockWorkflow.getReadyWorkflowSteps.mockReturnValue([]);
    mockBeads.ready.mockReturnValue([]);

    const dispatcher = new Dispatcher(testConfig, mockNotifier);
    (dispatcher as any).running = true;
    (dispatcher as any).getGitHubCIStatus = vi.fn(() => "passed");

    await (dispatcher as any).tick();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should just update CI status normally (no redirect for implementation steps)
    expect(mockWorkflow.updateStepCIStatus).toHaveBeenCalledWith("bd-w001.3", "passed", 0);
    expect(mockWorkflow.completeStep).not.toHaveBeenCalled();
    expect(mockWorkflow.createNextStep).not.toHaveBeenCalled();
    expect(mockWorkflow.addEpicLabel).not.toHaveBeenCalled();
  });
});
