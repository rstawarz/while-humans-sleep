import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getFirstAgent } from "./workflow.js";
import type { WorkItem, Handoff } from "./types.js";
import type { WorkflowEpic, WorkflowStep } from "./workflow.js";
import type { Bead } from "./beads/types.js";

// Mock the beads module
vi.mock("./beads/index.js", () => ({
  beads: {
    create: vi.fn(),
    close: vi.fn(),
    update: vi.fn(),
    comment: vi.fn(),
    show: vi.fn(),
    ready: vi.fn(),
    list: vi.fn(),
  },
}));

// Mock the config module
vi.mock("./config.js", () => ({
  loadConfig: vi.fn(() => ({
    orchestratorPath: "/mock/orchestrator",
    projects: [],
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
  })),
  expandPath: vi.fn((path: string) => path),
  getProject: vi.fn((name: string) => ({
    name,
    repoPath: `/mock/projects/${name}`,
    baseBranch: "main",
    agentsPath: "docs/llm/agents",
    beadsMode: "committed",
  })),
}));

describe("getFirstAgent", () => {
  const baseWorkItem: WorkItem = {
    id: "bd-test",
    project: "test",
    title: "Test",
    description: "Test",
    priority: 2,
    type: "task",
    status: "open",
    labels: [],
    dependencies: [],
  };

  it("returns implementation for task type", () => {
    const workItem: WorkItem = { ...baseWorkItem, type: "task" };
    expect(getFirstAgent(workItem)).toBe("implementation");
  });

  it("returns implementation for bug type", () => {
    const workItem: WorkItem = { ...baseWorkItem, type: "bug" };
    expect(getFirstAgent(workItem)).toBe("implementation");
  });

  it("returns planner for task with planning label", () => {
    const workItem: WorkItem = { ...baseWorkItem, type: "task", labels: ["planning"] };
    expect(getFirstAgent(workItem)).toBe("planner");
  });

  it("returns planner for epic type", () => {
    const workItem: WorkItem = { ...baseWorkItem, type: "epic" };
    expect(getFirstAgent(workItem)).toBe("planner");
  });
});

// Tests using mocked beads module
describe("workflow functions with mocked beads", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockBeads: any;

  beforeEach(async () => {
    vi.resetModules();
    const beadsModule = await import("./beads/index.js");
    mockBeads = beadsModule.beads;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("startWorkflow", () => {
    it("creates epic and first step", async () => {
      const { startWorkflow } = await import("./workflow.js");

      mockBeads.create.mockReturnValueOnce({ id: "bd-w001" }); // epic
      mockBeads.create.mockReturnValueOnce({ id: "bd-w001.1" }); // step

      const sourceBead: WorkItem = {
        id: "bd-src",
        project: "test",
        title: "Test Task",
        description: "Test description",
        priority: 2,
        type: "task",
        status: "open",
        labels: [],
        dependencies: [],
      };

      const result = await startWorkflow("test", sourceBead, "implementation");

      expect(result.epicId).toBe("bd-w001");
      expect(result.stepId).toBe("bd-w001.1");
      expect(mockBeads.create).toHaveBeenCalledTimes(2);

      // Verify epic creation call
      expect(mockBeads.create).toHaveBeenNthCalledWith(
        1,
        "test:bd-src - Test Task",
        "/mock/orchestrator",
        expect.objectContaining({
          type: "epic",
          priority: 2,
          labels: ["project:test", "source:bd-src"],
        })
      );

      // Verify step creation call
      expect(mockBeads.create).toHaveBeenNthCalledWith(
        2,
        "implementation",
        "/mock/orchestrator",
        expect.objectContaining({
          type: "task",
          parent: "bd-w001",
          labels: ["agent:implementation", "whs:step"],
        })
      );

      // Verify source bead is marked as in_progress
      expect(mockBeads.update).toHaveBeenCalledWith(
        "bd-src",
        "/mock/projects/test",
        { status: "in_progress" }
      );
    });
  });

  describe("createNextStep", () => {
    it("creates step with basic context", async () => {
      const { createNextStep } = await import("./workflow.js");

      mockBeads.create.mockReturnValue({ id: "bd-w001.2" });

      const result = createNextStep("bd-w001", "quality_review", "PR ready for review");

      expect(result).toBe("bd-w001.2");
      expect(mockBeads.create).toHaveBeenCalledWith(
        "quality_review",
        "/mock/orchestrator",
        expect.objectContaining({
          type: "task",
          parent: "bd-w001",
          labels: ["agent:quality_review", "whs:step"],
        })
      );
    });

    it("creates step with PR and CI status", async () => {
      const { createNextStep } = await import("./workflow.js");

      mockBeads.create.mockReturnValue({ id: "bd-w001.3" });

      const result = createNextStep("bd-w001", "implementation", "CI failed", {
        pr_number: 42,
        ci_status: "failed",
      });

      expect(result).toBe("bd-w001.3");
      expect(mockBeads.create).toHaveBeenCalledWith(
        "implementation",
        "/mock/orchestrator",
        expect.objectContaining({
          labels: ["agent:implementation", "whs:step", "pr:42", "ci:failed"],
        })
      );
    });
  });

  describe("completeStep", () => {
    it("closes step with outcome", async () => {
      const { completeStep } = await import("./workflow.js");

      completeStep("bd-w001.1", "pr_created");

      expect(mockBeads.close).toHaveBeenCalledWith(
        "bd-w001.1",
        "pr_created",
        "/mock/orchestrator"
      );
    });
  });

  describe("completeWorkflow", () => {
    it("closes epic on done", async () => {
      const { completeWorkflow } = await import("./workflow.js");

      completeWorkflow("bd-w001", "done", "All tasks complete");

      expect(mockBeads.close).toHaveBeenCalledWith(
        "bd-w001",
        "Complete: All tasks complete",
        "/mock/orchestrator"
      );
    });

    it("marks epic blocked on blocked", async () => {
      const { completeWorkflow } = await import("./workflow.js");

      completeWorkflow("bd-w001", "blocked", "Need human decision");

      expect(mockBeads.update).toHaveBeenCalledWith(
        "bd-w001",
        "/mock/orchestrator",
        expect.objectContaining({
          status: "blocked",
          labelAdd: ["blocked:human"],
        })
      );
      expect(mockBeads.comment).toHaveBeenCalledWith(
        "bd-w001",
        "Blocked: Need human decision",
        "/mock/orchestrator"
      );
    });
  });

  describe("getWorkflowContext", () => {
    it("returns step description", async () => {
      const { getWorkflowContext } = await import("./workflow.js");

      mockBeads.show.mockReturnValue({ description: "Step context here" });

      const context = getWorkflowContext("bd-w001.1");

      expect(context).toBe("Step context here");
      expect(mockBeads.show).toHaveBeenCalledWith("bd-w001.1", "/mock/orchestrator");
    });

    it("returns empty string on error", async () => {
      const { getWorkflowContext } = await import("./workflow.js");

      mockBeads.show.mockImplementation(() => {
        throw new Error("Not found");
      });

      const context = getWorkflowContext("bd-nonexistent");

      expect(context).toBe("");
    });

    it("returns empty string when description is undefined", async () => {
      const { getWorkflowContext } = await import("./workflow.js");

      mockBeads.show.mockReturnValue({});

      const context = getWorkflowContext("bd-w001.1");

      expect(context).toBe("");
    });
  });

  describe("getWorkflowEpic", () => {
    it("returns parent epic", async () => {
      const { getWorkflowEpic } = await import("./workflow.js");

      mockBeads.show
        .mockReturnValueOnce({ parent: "bd-w001" }) // step
        .mockReturnValueOnce({ id: "bd-w001", title: "Epic" }); // epic

      const epic = getWorkflowEpic("bd-w001.1");

      expect(epic).toEqual({ id: "bd-w001", title: "Epic" });
    });

    it("returns null when step has no parent", async () => {
      const { getWorkflowEpic } = await import("./workflow.js");

      mockBeads.show.mockReturnValue({});

      const epic = getWorkflowEpic("bd-w001.1");

      expect(epic).toBeNull();
    });

    it("returns null on error", async () => {
      const { getWorkflowEpic } = await import("./workflow.js");

      mockBeads.show.mockImplementation(() => {
        throw new Error("Not found");
      });

      const epic = getWorkflowEpic("bd-nonexistent");

      expect(epic).toBeNull();
    });
  });

  describe("getReadyWorkflowSteps", () => {
    it("returns mapped workflow steps", async () => {
      const { getReadyWorkflowSteps } = await import("./workflow.js");

      mockBeads.ready.mockReturnValue([
        {
          id: "bd-w001.1",
          title: "implementation",
          description: "Work context",
          parent: "bd-w001",
          labels: ["agent:implementation"],
          status: "open",
        },
        {
          id: "bd-w002.1",
          title: "quality_review",
          description: "Review PR",
          parent: "bd-w002",
          labels: ["agent:quality_review", "pr:42"],
          status: "open",
        },
      ]);

      const steps = getReadyWorkflowSteps();

      expect(steps).toHaveLength(2);
      expect(steps[0].id).toBe("bd-w001.1");
      expect(steps[0].agent).toBe("implementation");
      expect(steps[1].agent).toBe("quality_review");
    });

    it("only returns beads with whs:step label", async () => {
      const { getReadyWorkflowSteps } = await import("./workflow.js");

      // Verify that beads.ready is called with labelAll to only include workflow steps
      mockBeads.ready.mockReturnValue([
        {
          id: "bd-w001.1",
          title: "implementation",
          description: "Work context",
          parent: "bd-w001",
          labels: ["agent:implementation", "whs:step"],
          status: "open",
        },
      ]);

      getReadyWorkflowSteps();

      // The key assertion: beads.ready should be called with labelAll: ["whs:step"]
      expect(mockBeads.ready).toHaveBeenCalledWith(
        "/mock/orchestrator",
        expect.objectContaining({
          type: "task",
          labelAll: ["whs:step"],
        })
      );
    });

    it("returns empty array on error", async () => {
      const { getReadyWorkflowSteps } = await import("./workflow.js");

      mockBeads.ready.mockImplementation(() => {
        throw new Error("Failed");
      });

      const steps = getReadyWorkflowSteps();

      expect(steps).toEqual([]);
    });

    it("filters out steps with ci:pending label", async () => {
      const { getReadyWorkflowSteps } = await import("./workflow.js");

      mockBeads.ready.mockReturnValue([
        {
          id: "bd-w001.1",
          title: "implementation",
          parent: "bd-w001",
          labels: ["agent:implementation", "whs:step"],
          status: "open",
        },
        {
          id: "bd-w001.2",
          title: "quality_review",
          parent: "bd-w001",
          labels: ["agent:quality_review", "whs:step", "ci:pending", "pr:42"],
          status: "open",
        },
      ]);

      const steps = getReadyWorkflowSteps();

      // Only the implementation step should be returned (no ci:pending)
      expect(steps).toHaveLength(1);
      expect(steps[0].id).toBe("bd-w001.1");
    });
  });

  describe("getStepsPendingCI", () => {
    it("returns steps with ci:pending label and PR number", async () => {
      const { getStepsPendingCI } = await import("./workflow.js");

      mockBeads.list.mockReturnValue([
        {
          id: "bd-w001.2",
          title: "quality_review",
          parent: "bd-w001",
          labels: ["agent:quality_review", "whs:step", "ci:pending", "pr:42"],
          status: "open",
        },
        {
          id: "bd-w002.1",
          title: "quality_review",
          parent: "bd-w002",
          labels: ["agent:quality_review", "whs:step", "ci:pending", "pr:99", "ci-retries:2"],
          status: "open",
        },
      ]);

      const steps = getStepsPendingCI();

      expect(steps).toHaveLength(2);
      expect(steps[0]).toEqual({
        id: "bd-w001.2",
        epicId: "bd-w001",
        prNumber: 42,
        retryCount: 0,
      });
      expect(steps[1]).toEqual({
        id: "bd-w002.1",
        epicId: "bd-w002",
        prNumber: 99,
        retryCount: 2,
      });
    });

    it("filters out steps without PR number", async () => {
      const { getStepsPendingCI } = await import("./workflow.js");

      mockBeads.list.mockReturnValue([
        {
          id: "bd-w001.2",
          title: "quality_review",
          parent: "bd-w001",
          labels: ["agent:quality_review", "whs:step", "ci:pending"], // No pr:XX label
          status: "open",
        },
      ]);

      const steps = getStepsPendingCI();

      expect(steps).toHaveLength(0);
    });

    it("returns empty array on error", async () => {
      const { getStepsPendingCI } = await import("./workflow.js");

      mockBeads.list.mockImplementation(() => {
        throw new Error("Failed");
      });

      const steps = getStepsPendingCI();

      expect(steps).toEqual([]);
    });
  });

  describe("updateStepCIStatus", () => {
    it("updates labels for CI passed", async () => {
      const { updateStepCIStatus } = await import("./workflow.js");

      updateStepCIStatus("bd-w001.2", "passed", 0);

      expect(mockBeads.update).toHaveBeenCalledWith(
        "bd-w001.2",
        "/mock/orchestrator",
        expect.objectContaining({
          labelAdd: ["ci:passed"],
          labelRemove: expect.arrayContaining(["ci:pending", "ci:passed", "ci:failed"]),
        })
      );
    });

    it("updates labels for CI failed and increments retry count", async () => {
      const { updateStepCIStatus } = await import("./workflow.js");

      updateStepCIStatus("bd-w001.2", "failed", 2);

      expect(mockBeads.update).toHaveBeenCalledWith(
        "bd-w001.2",
        "/mock/orchestrator",
        expect.objectContaining({
          labelAdd: ["ci:failed", "ci-retries:3"],
          labelRemove: expect.arrayContaining(["ci:pending", "ci-retries:2"]),
        })
      );
    });
  });

  describe("getActiveWorkflows", () => {
    it("returns mapped workflow epics", async () => {
      const { getActiveWorkflows } = await import("./workflow.js");

      mockBeads.list.mockReturnValue([
        {
          id: "bd-w001",
          title: "test:bd-src - Task",
          labels: ["project:test", "source:bd-src"],
          status: "open",
          created_at: "2024-01-15T10:00:00Z",
        },
      ]);

      const workflows = getActiveWorkflows();

      expect(workflows).toHaveLength(1);
      expect(workflows[0].id).toBe("bd-w001");
      expect(workflows[0].sourceProject).toBe("test");
      expect(workflows[0].sourceBeadId).toBe("bd-src");
    });

    it("returns empty array on error", async () => {
      const { getActiveWorkflows } = await import("./workflow.js");

      mockBeads.list.mockImplementation(() => {
        throw new Error("Failed");
      });

      const workflows = getActiveWorkflows();

      expect(workflows).toEqual([]);
    });
  });

  describe("getWorkflowForSource", () => {
    it("returns workflow epic for source", async () => {
      const { getWorkflowForSource } = await import("./workflow.js");

      mockBeads.list.mockReturnValue([
        {
          id: "bd-w001",
          title: "test:bd-src - Task",
          status: "open",
          created_at: "2024-01-15T10:00:00Z",
        },
      ]);

      const workflow = getWorkflowForSource("test", "bd-src");

      expect(workflow).not.toBeNull();
      expect(workflow?.id).toBe("bd-w001");
      expect(mockBeads.list).toHaveBeenCalledWith(
        "/mock/orchestrator",
        expect.objectContaining({
          type: "epic",
          labelAll: ["project:test", "source:bd-src"],
        })
      );
    });

    it("returns null when no workflow found", async () => {
      const { getWorkflowForSource } = await import("./workflow.js");

      mockBeads.list.mockReturnValue([]);

      const workflow = getWorkflowForSource("test", "bd-nonexistent");

      expect(workflow).toBeNull();
    });

    it("returns null on error", async () => {
      const { getWorkflowForSource } = await import("./workflow.js");

      mockBeads.list.mockImplementation(() => {
        throw new Error("Failed");
      });

      const workflow = getWorkflowForSource("test", "bd-src");

      expect(workflow).toBeNull();
    });
  });

  describe("markStepInProgress", () => {
    it("updates step status to in_progress", async () => {
      const { markStepInProgress } = await import("./workflow.js");

      markStepInProgress("bd-w001.1");

      expect(mockBeads.update).toHaveBeenCalledWith(
        "bd-w001.1",
        "/mock/orchestrator",
        { status: "in_progress" }
      );
    });
  });

  describe("resetStepForRetry", () => {
    it("resets step to open and increments dispatch attempts", async () => {
      const { resetStepForRetry } = await import("./workflow.js");

      // Step has no dispatch-attempts label (first failure)
      mockBeads.show.mockReturnValue({
        id: "bd-w001.1",
        labels: ["agent:implementation", "whs:step"],
        parent: "bd-w001",
      });

      const result = resetStepForRetry("bd-w001.1", 3);

      expect(result).toBe(true);
      // Should increment dispatch attempts
      expect(mockBeads.update).toHaveBeenCalledWith(
        "bd-w001.1",
        "/mock/orchestrator",
        expect.objectContaining({
          labelAdd: ["dispatch-attempts:1"],
        })
      );
      // Should reset to open
      expect(mockBeads.update).toHaveBeenCalledWith(
        "bd-w001.1",
        "/mock/orchestrator",
        { status: "open" }
      );
    });

    it("trips circuit breaker after max attempts", async () => {
      const { resetStepForRetry } = await import("./workflow.js");

      // Step already has 3 dispatch attempts
      mockBeads.show.mockReturnValue({
        id: "bd-w001.1",
        labels: ["agent:implementation", "whs:step", "dispatch-attempts:3"],
        parent: "bd-w001",
      });

      const result = resetStepForRetry("bd-w001.1", 3);

      expect(result).toBe(false);
      // Should mark parent epic as blocked
      expect(mockBeads.update).toHaveBeenCalledWith(
        "bd-w001",
        "/mock/orchestrator",
        expect.objectContaining({
          status: "blocked",
          labelAdd: ["blocked:human"],
        })
      );
      // Should add a comment explaining why
      expect(mockBeads.comment).toHaveBeenCalledWith(
        "bd-w001",
        expect.stringContaining("failed to dispatch after 3 attempts"),
        "/mock/orchestrator"
      );
      // Should close the step
      expect(mockBeads.close).toHaveBeenCalledWith(
        "bd-w001.1",
        expect.stringContaining("Failed to dispatch after 3 attempts"),
        "/mock/orchestrator"
      );
    });

    it("handles step without parent gracefully on circuit break", async () => {
      const { resetStepForRetry } = await import("./workflow.js");

      mockBeads.show.mockReturnValue({
        id: "bd-w001.1",
        labels: ["dispatch-attempts:3"],
        // No parent
      });

      const result = resetStepForRetry("bd-w001.1", 3);

      expect(result).toBe(false);
      // Should still close the step
      expect(mockBeads.close).toHaveBeenCalled();
    });
  });

  describe("getDispatchAttempts", () => {
    it("returns 0 when no dispatch-attempts label", async () => {
      const { getDispatchAttempts } = await import("./workflow.js");

      mockBeads.show.mockReturnValue({
        id: "bd-w001.1",
        labels: ["agent:implementation", "whs:step"],
      });

      expect(getDispatchAttempts("bd-w001.1")).toBe(0);
    });

    it("returns count from dispatch-attempts label", async () => {
      const { getDispatchAttempts } = await import("./workflow.js");

      mockBeads.show.mockReturnValue({
        id: "bd-w001.1",
        labels: ["agent:implementation", "dispatch-attempts:2"],
      });

      expect(getDispatchAttempts("bd-w001.1")).toBe(2);
    });

    it("returns 0 on error", async () => {
      const { getDispatchAttempts } = await import("./workflow.js");

      mockBeads.show.mockImplementation(() => {
        throw new Error("Not found");
      });

      expect(getDispatchAttempts("nonexistent")).toBe(0);
    });
  });

  describe("addStepComment", () => {
    it("adds comment to step", async () => {
      const { addStepComment } = await import("./workflow.js");

      addStepComment("bd-w001.1", "Progress note");

      expect(mockBeads.comment).toHaveBeenCalledWith(
        "bd-w001.1",
        "Progress note",
        "/mock/orchestrator"
      );
    });
  });

  describe("getSourceBeadInfo", () => {
    it("returns source info from epic labels", async () => {
      const { getSourceBeadInfo } = await import("./workflow.js");

      mockBeads.show.mockReturnValue({
        id: "bd-w001",
        labels: ["project:myproject", "source:bd-123"],
      });

      const info = getSourceBeadInfo("bd-w001");

      expect(info).toEqual({ project: "myproject", beadId: "bd-123" });
    });

    it("returns null when labels missing", async () => {
      const { getSourceBeadInfo } = await import("./workflow.js");

      mockBeads.show.mockReturnValue({
        id: "bd-w001",
        labels: [],
      });

      const info = getSourceBeadInfo("bd-w001");

      expect(info).toBeNull();
    });

    it("returns null on error", async () => {
      const { getSourceBeadInfo } = await import("./workflow.js");

      mockBeads.show.mockImplementation(() => {
        throw new Error("Not found");
      });

      const info = getSourceBeadInfo("bd-nonexistent");

      expect(info).toBeNull();
    });
  });

  describe("getOrchestratorPath", () => {
    it("returns path from config", async () => {
      const { getOrchestratorPath } = await import("./workflow.js");

      const path = getOrchestratorPath();

      expect(path).toBe("/mock/orchestrator");
    });
  });
});

describe("workflow label parsing", () => {
  // Test the label format expectations

  it("epic labels should contain project and source", () => {
    const labels = ["project:my-project", "source:bd-123"];

    const project = labels.find(l => l.startsWith("project:"))?.replace("project:", "");
    const source = labels.find(l => l.startsWith("source:"))?.replace("source:", "");

    expect(project).toBe("my-project");
    expect(source).toBe("bd-123");
  });

  it("step labels should contain agent", () => {
    const labels = ["agent:implementation", "pr:42"];

    const agent = labels.find(l => l.startsWith("agent:"))?.replace("agent:", "");
    const pr = labels.find(l => l.startsWith("pr:"))?.replace("pr:", "");

    expect(agent).toBe("implementation");
    expect(pr).toBe("42");
  });
});

describe("workflow context building", () => {
  it("builds context with PR number and CI status", () => {
    const handoff = {
      next_agent: "quality_review",
      pr_number: 42,
      ci_status: "pending" as const,
      context: "Implementation complete",
    };

    // Simulate what createNextStep does
    const lines = [handoff.context];
    if (handoff.pr_number) {
      lines.push("", `PR: #${handoff.pr_number}`);
    }
    if (handoff.ci_status) {
      lines.push(`CI Status: ${handoff.ci_status}`);
    }

    const description = lines.join("\n");
    expect(description).toContain("Implementation complete");
    expect(description).toContain("PR: #42");
    expect(description).toContain("CI Status: pending");
  });
});

describe("WorkflowEpic type", () => {
  it("has required fields", () => {
    const epic: WorkflowEpic = {
      id: "bd-w001",
      sourceProject: "argyn",
      sourceBeadId: "bd-a3f8",
      title: "argyn:bd-a3f8 - Add authentication",
      status: "open",
      createdAt: new Date("2024-01-15T10:00:00Z"),
    };

    expect(epic.id).toBe("bd-w001");
    expect(epic.sourceProject).toBe("argyn");
    expect(epic.sourceBeadId).toBe("bd-a3f8");
    expect(epic.status).toBe("open");
  });

  it("supports optional currentStepId", () => {
    const epicWithStep: WorkflowEpic = {
      id: "bd-w001",
      sourceProject: "argyn",
      sourceBeadId: "bd-a3f8",
      title: "Test",
      status: "in_progress",
      currentStepId: "bd-w001.2",
      createdAt: new Date(),
    };

    expect(epicWithStep.currentStepId).toBe("bd-w001.2");
  });

  it("supports all status values", () => {
    const statuses: WorkflowEpic["status"][] = ["open", "in_progress", "blocked", "closed"];

    for (const status of statuses) {
      const epic: WorkflowEpic = {
        id: "test",
        sourceProject: "test",
        sourceBeadId: "test",
        title: "test",
        status,
        createdAt: new Date(),
      };
      expect(epic.status).toBe(status);
    }
  });
});

describe("WorkflowStep type", () => {
  it("has required fields", () => {
    const step: WorkflowStep = {
      id: "bd-w001.1",
      epicId: "bd-w001",
      agent: "implementation",
      context: "Starting work on authentication",
      status: "open",
    };

    expect(step.id).toBe("bd-w001.1");
    expect(step.epicId).toBe("bd-w001");
    expect(step.agent).toBe("implementation");
    expect(step.status).toBe("open");
  });

  it("supports optional outcome", () => {
    const completedStep: WorkflowStep = {
      id: "bd-w001.1",
      epicId: "bd-w001",
      agent: "implementation",
      context: "Work context",
      status: "closed",
      outcome: "pr_created",
    };

    expect(completedStep.outcome).toBe("pr_created");
  });
});

describe("handoff to workflow step conversion", () => {
  it("converts handoff with all fields", () => {
    const handoff: Handoff = {
      next_agent: "quality_review",
      pr_number: 42,
      ci_status: "pending",
      context: "Implementation complete.\nAll tests passing.",
    };

    // Simulate the conversion logic
    const labels = [`agent:${handoff.next_agent}`];
    if (handoff.pr_number) labels.push(`pr:${handoff.pr_number}`);
    if (handoff.ci_status) labels.push(`ci:${handoff.ci_status}`);

    expect(labels).toContain("agent:quality_review");
    expect(labels).toContain("pr:42");
    expect(labels).toContain("ci:pending");
  });

  it("converts handoff with minimal fields", () => {
    const handoff: Handoff = {
      next_agent: "architect",
      context: "Need help with design decision",
    };

    const labels = [`agent:${handoff.next_agent}`];
    if (handoff.pr_number) labels.push(`pr:${handoff.pr_number}`);
    if (handoff.ci_status) labels.push(`ci:${handoff.ci_status}`);

    expect(labels).toHaveLength(1);
    expect(labels).toContain("agent:architect");
  });

  it("handles DONE handoff", () => {
    const handoff: Handoff = {
      next_agent: "DONE",
      pr_number: 42,
      ci_status: "passed",
      context: "Task complete. PR merged.",
    };

    expect(handoff.next_agent).toBe("DONE");
  });

  it("handles BLOCKED handoff", () => {
    const handoff: Handoff = {
      next_agent: "BLOCKED",
      context: "Need human decision on licensing",
    };

    expect(handoff.next_agent).toBe("BLOCKED");
  });
});

describe("agent extraction from labels", () => {
  it("extracts agent from agent: label", () => {
    const labels = ["agent:implementation", "pr:42"];
    const agentLabel = labels.find((l) => l.startsWith("agent:"));
    const agent = agentLabel?.replace("agent:", "");

    expect(agent).toBe("implementation");
  });

  it("handles missing agent label", () => {
    const labels = ["pr:42", "ci:passed"];
    const agentLabel = labels.find((l) => l.startsWith("agent:"));

    expect(agentLabel).toBeUndefined();
  });

  it("handles complex agent names", () => {
    const labels = ["agent:quality_review"];
    const agentLabel = labels.find((l) => l.startsWith("agent:"));
    const agent = agentLabel?.replace("agent:", "");

    expect(agent).toBe("quality_review");
  });
});

describe("epic title parsing", () => {
  it("parses project:beadId - title format", () => {
    const title = "argyn:bd-a3f8 - Add user authentication";

    const match = title.match(/^(.+):(.+) - (.+)$/);
    expect(match).not.toBeNull();

    const [, project, beadId, taskTitle] = match!;
    expect(project).toBe("argyn");
    expect(beadId).toBe("bd-a3f8");
    expect(taskTitle).toBe("Add user authentication");
  });

  it("handles titles with colons", () => {
    const title = "my-project:bd-123 - Fix: auth module";

    // Use a more robust parsing approach
    const firstColon = title.indexOf(":");
    const dashIndex = title.indexOf(" - ");

    const project = title.slice(0, firstColon);
    const beadId = title.slice(firstColon + 1, dashIndex);
    const taskTitle = title.slice(dashIndex + 3);

    expect(project).toBe("my-project");
    expect(beadId).toBe("bd-123");
    expect(taskTitle).toBe("Fix: auth module");
  });
});

// Integration tests that require beads CLI and orchestrator setup
describe.skip("workflow integration", () => {
  it("creates workflow epic and first step", async () => {
    // Would need orchestrator beads repo set up
  });

  it("creates next step after handoff", async () => {
    // Would need running workflow
  });

  it("completes workflow on DONE", async () => {
    // Would need running workflow
  });

  it("marks workflow blocked on BLOCKED", async () => {
    // Would need running workflow
  });
});

// Test internal helper functions
describe("extractAgentFromBead", () => {
  it("extracts agent from agent: label", () => {
    const bead = {
      id: "bd-test",
      title: "implementation",
      labels: ["agent:quality_review", "pr:42"],
      description: "",
      priority: 2,
      type: "task",
      status: "open",
    };

    // Simulate extractAgentFromBead
    const agentLabel = bead.labels?.find((l) => l.startsWith("agent:"));
    const agent = agentLabel ? agentLabel.replace("agent:", "") : bead.title;

    expect(agent).toBe("quality_review");
  });

  it("falls back to title when no agent label", () => {
    const bead = {
      id: "bd-test",
      title: "implementation",
      labels: ["pr:42"],
      description: "",
      priority: 2,
      type: "task",
      status: "open",
    };

    // Simulate extractAgentFromBead
    const agentLabel = bead.labels?.find((l) => l.startsWith("agent:"));
    const agent = agentLabel ? agentLabel.replace("agent:", "") : bead.title;

    expect(agent).toBe("implementation");
  });

  it("handles missing labels array", () => {
    const bead = {
      id: "bd-test",
      title: "architect",
      description: "",
      priority: 2,
      type: "task",
      status: "open",
    };

    // Simulate extractAgentFromBead
    const agentLabel = (bead as { labels?: string[] }).labels?.find((l) => l.startsWith("agent:"));
    const agent = agentLabel ? agentLabel.replace("agent:", "") : bead.title;

    expect(agent).toBe("architect");
  });
});

describe("parseEpicLabels", () => {
  it("parses project and source labels", () => {
    const labels = ["project:my-project", "source:bd-123", "other:label"];

    // Simulate parseEpicLabels
    let project = "";
    let sourceId = "";
    for (const label of labels) {
      if (label.startsWith("project:")) {
        project = label.replace("project:", "");
      } else if (label.startsWith("source:")) {
        sourceId = label.replace("source:", "");
      }
    }

    expect(project).toBe("my-project");
    expect(sourceId).toBe("bd-123");
  });

  it("returns empty strings for missing labels", () => {
    const labels = ["other:label", "random:tag"];

    // Simulate parseEpicLabels
    let project = "";
    let sourceId = "";
    for (const label of labels) {
      if (label.startsWith("project:")) {
        project = label.replace("project:", "");
      } else if (label.startsWith("source:")) {
        sourceId = label.replace("source:", "");
      }
    }

    expect(project).toBe("");
    expect(sourceId).toBe("");
  });

  it("handles empty labels array", () => {
    const labels: string[] = [];

    let project = "";
    let sourceId = "";
    for (const label of labels) {
      if (label.startsWith("project:")) {
        project = label.replace("project:", "");
      } else if (label.startsWith("source:")) {
        sourceId = label.replace("source:", "");
      }
    }

    expect(project).toBe("");
    expect(sourceId).toBe("");
  });
});

describe("workflow step context building", () => {
  it("builds basic context without handoff details", () => {
    const context = "Starting work on authentication";
    const handoff: Partial<Handoff> = {};

    // Simulate createNextStep description building
    const descriptionLines = [context];
    if (handoff.pr_number) {
      descriptionLines.push("", `PR: #${handoff.pr_number}`);
    }
    if (handoff.ci_status) {
      descriptionLines.push(`CI Status: ${handoff.ci_status}`);
    }

    const description = descriptionLines.join("\n");
    expect(description).toBe("Starting work on authentication");
  });

  it("builds context with PR number only", () => {
    const context = "Implementation complete";
    const handoff: Partial<Handoff> = { pr_number: 42 };

    const descriptionLines = [context];
    if (handoff.pr_number) {
      descriptionLines.push("", `PR: #${handoff.pr_number}`);
    }
    if (handoff.ci_status) {
      descriptionLines.push(`CI Status: ${handoff.ci_status}`);
    }

    const description = descriptionLines.join("\n");
    expect(description).toContain("Implementation complete");
    expect(description).toContain("PR: #42");
  });

  it("builds context with all handoff details", () => {
    const context = "CI failed, needs fixes";
    const handoff: Partial<Handoff> = { pr_number: 42, ci_status: "failed" };

    const descriptionLines = [context];
    if (handoff.pr_number) {
      descriptionLines.push("", `PR: #${handoff.pr_number}`);
    }
    if (handoff.ci_status) {
      descriptionLines.push(`CI Status: ${handoff.ci_status}`);
    }

    const description = descriptionLines.join("\n");
    expect(description).toContain("CI failed, needs fixes");
    expect(description).toContain("PR: #42");
    expect(description).toContain("CI Status: failed");
  });
});

describe("workflow step labels building", () => {
  it("builds labels with agent only", () => {
    const agent = "implementation";
    const handoff: Partial<Handoff> = {};

    // Simulate createNextStep label building
    const labels = [`agent:${agent}`];
    if (handoff.pr_number) {
      labels.push(`pr:${handoff.pr_number}`);
    }
    if (handoff.ci_status) {
      labels.push(`ci:${handoff.ci_status}`);
    }

    expect(labels).toEqual(["agent:implementation"]);
  });

  it("builds labels with all handoff details", () => {
    const agent = "quality_review";
    const handoff: Partial<Handoff> = { pr_number: 123, ci_status: "pending" };

    const labels = [`agent:${agent}`];
    if (handoff.pr_number) {
      labels.push(`pr:${handoff.pr_number}`);
    }
    if (handoff.ci_status) {
      labels.push(`ci:${handoff.ci_status}`);
    }

    expect(labels).toContain("agent:quality_review");
    expect(labels).toContain("pr:123");
    expect(labels).toContain("ci:pending");
  });
});

describe("workflow epic title/description building", () => {
  it("builds epic title from project and source bead", () => {
    const project = "argyn";
    const sourceBead: WorkItem = {
      id: "bd-a3f8",
      project: "argyn",
      title: "Add user authentication",
      description: "Implement auth with JWT",
      priority: 1,
      type: "task",
      status: "open",
      labels: [],
      dependencies: [],
    };

    // Simulate startWorkflow epic title building
    const epicTitle = `${project}:${sourceBead.id} - ${sourceBead.title}`;

    expect(epicTitle).toBe("argyn:bd-a3f8 - Add user authentication");
  });

  it("builds epic description with source info", () => {
    const project = "argyn";
    const sourceBead: WorkItem = {
      id: "bd-a3f8",
      project: "argyn",
      title: "Add user authentication",
      description: "Implement auth with JWT tokens.\n\nRequirements:\n- Login endpoint\n- Token refresh",
      priority: 0,
      type: "epic",
      status: "open",
      labels: [],
      dependencies: [],
    };

    // Simulate startWorkflow epic description building
    const epicDescription = [
      `Source: ${project}/${sourceBead.id}`,
      `Priority: ${sourceBead.priority}`,
      `Type: ${sourceBead.type}`,
      "",
      "## Original Description",
      sourceBead.description,
    ].join("\n");

    expect(epicDescription).toContain("Source: argyn/bd-a3f8");
    expect(epicDescription).toContain("Priority: 0");
    expect(epicDescription).toContain("Type: epic");
    expect(epicDescription).toContain("## Original Description");
    expect(epicDescription).toContain("Implement auth with JWT tokens");
    expect(epicDescription).toContain("Login endpoint");
  });
});

describe("workflow step context building for first step", () => {
  it("builds first step context from source bead", () => {
    const sourceBead: WorkItem = {
      id: "bd-a3f8",
      project: "argyn",
      title: "Add user authentication",
      description: "Implement auth with JWT",
      priority: 1,
      type: "task",
      status: "open",
      labels: [],
      dependencies: [],
    };

    // Simulate startWorkflow step context building
    const stepContext = [
      `Starting workflow for: ${sourceBead.title}`,
      "",
      sourceBead.description,
    ].join("\n");

    expect(stepContext).toContain("Starting workflow for: Add user authentication");
    expect(stepContext).toContain("Implement auth with JWT");
  });
});

describe("getActiveWorkflows mapping", () => {
  it("maps bead to WorkflowEpic structure", () => {
    const bead = {
      id: "bd-w001",
      title: "argyn:bd-a3f8 - Add auth",
      description: "Epic description",
      priority: 1,
      type: "epic",
      status: "open",
      labels: ["project:argyn", "source:bd-a3f8"],
      created_at: "2024-01-15T10:00:00Z",
    };

    // Simulate getActiveWorkflows mapping
    const labels = bead.labels || [];
    let project = "";
    let sourceId = "";
    for (const label of labels) {
      if (label.startsWith("project:")) {
        project = label.replace("project:", "");
      } else if (label.startsWith("source:")) {
        sourceId = label.replace("source:", "");
      }
    }

    const epic: WorkflowEpic = {
      id: bead.id,
      sourceProject: project,
      sourceBeadId: sourceId,
      title: bead.title,
      status: bead.status as "open" | "in_progress" | "blocked" | "closed",
      createdAt: new Date(bead.created_at || Date.now()),
    };

    expect(epic.id).toBe("bd-w001");
    expect(epic.sourceProject).toBe("argyn");
    expect(epic.sourceBeadId).toBe("bd-a3f8");
    expect(epic.title).toBe("argyn:bd-a3f8 - Add auth");
    expect(epic.status).toBe("open");
  });
});

describe("getReadyWorkflowSteps mapping", () => {
  it("maps bead to WorkflowStep structure", () => {
    const bead = {
      id: "bd-w001.1",
      title: "implementation",
      description: "Starting work on authentication",
      priority: 2,
      type: "task",
      status: "open",
      parent: "bd-w001",
      labels: ["agent:implementation"],
    };

    // Simulate getReadyWorkflowSteps mapping
    const agentLabel = bead.labels?.find((l) => l.startsWith("agent:"));
    const agent = agentLabel ? agentLabel.replace("agent:", "") : bead.title;

    const step: WorkflowStep = {
      id: bead.id,
      epicId: bead.parent || "",
      agent: agent,
      context: bead.description || "",
      status: bead.status as "open" | "in_progress" | "closed",
    };

    expect(step.id).toBe("bd-w001.1");
    expect(step.epicId).toBe("bd-w001");
    expect(step.agent).toBe("implementation");
    expect(step.context).toBe("Starting work on authentication");
    expect(step.status).toBe("open");
  });
});
