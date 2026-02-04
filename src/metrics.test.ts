import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import {
  recordWorkflowStart,
  recordWorkflowComplete,
  recordStepStart,
  recordStepComplete,
  getWorkflow,
  getWorkflowSteps,
  getProjectMetrics,
  getAgentMetrics,
  getRecentWorkflows,
  getRunningWorkflows,
  getTotalCost,
  clearMetrics,
  closeDb,
  initDb,
} from "./metrics.js";

describe("metrics", () => {
  beforeAll(() => {
    // Use in-memory database for test isolation
    initDb(":memory:");
  });

  beforeEach(() => {
    clearMetrics();
  });

  afterAll(() => {
    closeDb();
  });

  describe("workflow tracking", () => {
    it("records workflow start", () => {
      recordWorkflowStart("wf-001", "argyn", "bd-a3f8");

      const workflow = getWorkflow("wf-001");
      expect(workflow).not.toBeNull();
      expect(workflow?.project).toBe("argyn");
      expect(workflow?.source_bead).toBe("bd-a3f8");
      expect(workflow?.status).toBe("running");
      expect(workflow?.total_cost).toBe(0);
      expect(workflow?.started_at).toBeDefined();
      expect(workflow?.completed_at).toBeNull();
    });

    it("records workflow completion with calculated cost", () => {
      recordWorkflowStart("wf-002", "argyn", "bd-a3f8");
      recordStepStart("step-001", "wf-002", "implementation");
      recordStepComplete("step-001", 0.05, "pr_created");
      recordStepStart("step-002", "wf-002", "quality_review");
      recordStepComplete("step-002", 0.03, "approved");

      recordWorkflowComplete("wf-002", "done");

      const workflow = getWorkflow("wf-002");
      expect(workflow?.status).toBe("done");
      expect(workflow?.total_cost).toBeCloseTo(0.08);
      expect(workflow?.completed_at).toBeDefined();
    });

    it("records workflow completion with explicit cost", () => {
      recordWorkflowStart("wf-003", "argyn", "bd-a3f8");
      recordWorkflowComplete("wf-003", "blocked", 0.10);

      const workflow = getWorkflow("wf-003");
      expect(workflow?.status).toBe("blocked");
      expect(workflow?.total_cost).toBeCloseTo(0.10);
    });

    it("returns null for non-existent workflow", () => {
      const workflow = getWorkflow("non-existent");
      expect(workflow).toBeNull();
    });
  });

  describe("step tracking", () => {
    it("records step start", () => {
      recordWorkflowStart("wf-004", "argyn", "bd-a3f8");
      recordStepStart("step-003", "wf-004", "implementation");

      const steps = getWorkflowSteps("wf-004");
      expect(steps).toHaveLength(1);
      expect(steps[0].agent).toBe("implementation");
      expect(steps[0].cost).toBe(0);
      expect(steps[0].outcome).toBeNull();
    });

    it("records step completion", () => {
      recordWorkflowStart("wf-005", "argyn", "bd-a3f8");
      recordStepStart("step-004", "wf-005", "quality_review");
      recordStepComplete("step-004", 0.025, "changes_requested");

      const steps = getWorkflowSteps("wf-005");
      expect(steps[0].cost).toBeCloseTo(0.025);
      expect(steps[0].outcome).toBe("changes_requested");
      expect(steps[0].completed_at).toBeDefined();
    });

    it("tracks multiple steps for a workflow", () => {
      recordWorkflowStart("wf-006", "argyn", "bd-a3f8");
      recordStepStart("step-005", "wf-006", "implementation");
      recordStepComplete("step-005", 0.04, "pr_created");
      recordStepStart("step-006", "wf-006", "quality_review");
      recordStepComplete("step-006", 0.02, "approved");
      recordStepStart("step-007", "wf-006", "release_manager");
      recordStepComplete("step-007", 0.01, "merged");

      const steps = getWorkflowSteps("wf-006");
      expect(steps).toHaveLength(3);
      expect(steps.map((s) => s.agent)).toEqual([
        "implementation",
        "quality_review",
        "release_manager",
      ]);
    });

    it("returns empty array for workflow with no steps", () => {
      recordWorkflowStart("wf-007", "argyn", "bd-a3f8");
      const steps = getWorkflowSteps("wf-007");
      expect(steps).toEqual([]);
    });
  });

  describe("aggregations", () => {
    beforeEach(() => {
      // Set up test data
      recordWorkflowStart("wf-a1", "argyn", "bd-001");
      recordStepStart("s-a1-1", "wf-a1", "implementation");
      recordStepComplete("s-a1-1", 0.05, "done");
      recordStepStart("s-a1-2", "wf-a1", "quality_review");
      recordStepComplete("s-a1-2", 0.03, "done");
      recordWorkflowComplete("wf-a1", "done");

      recordWorkflowStart("wf-a2", "argyn", "bd-002");
      recordStepStart("s-a2-1", "wf-a2", "implementation");
      recordStepComplete("s-a2-1", 0.04, "done");
      recordWorkflowComplete("wf-a2", "done");

      recordWorkflowStart("wf-b1", "bridget", "bd-001");
      recordStepStart("s-b1-1", "wf-b1", "implementation");
      recordStepComplete("s-b1-1", 0.10, "done");
      recordWorkflowComplete("wf-b1", "done");
    });

    it("calculates project metrics", () => {
      const metrics = getProjectMetrics();

      expect(metrics).toHaveLength(2);

      const argynMetrics = metrics.find((m) => m.project === "argyn");
      expect(argynMetrics?.workflow_count).toBe(2);
      expect(argynMetrics?.step_count).toBe(3);
      expect(argynMetrics?.total_cost).toBeCloseTo(0.12);
      expect(argynMetrics?.avg_cost_per_workflow).toBeCloseTo(0.06);

      const bridgetMetrics = metrics.find((m) => m.project === "bridget");
      expect(bridgetMetrics?.workflow_count).toBe(1);
      expect(bridgetMetrics?.step_count).toBe(1);
      expect(bridgetMetrics?.total_cost).toBeCloseTo(0.10);
    });

    it("calculates agent metrics", () => {
      const metrics = getAgentMetrics();

      expect(metrics).toHaveLength(2);

      const implMetrics = metrics.find((m) => m.agent === "implementation");
      expect(implMetrics?.step_count).toBe(3);
      expect(implMetrics?.total_cost).toBeCloseTo(0.19);
      expect(implMetrics?.avg_cost_per_step).toBeCloseTo(0.19 / 3);

      const qrMetrics = metrics.find((m) => m.agent === "quality_review");
      expect(qrMetrics?.step_count).toBe(1);
      expect(qrMetrics?.total_cost).toBeCloseTo(0.03);
    });

    it("calculates total cost", () => {
      const total = getTotalCost();
      expect(total).toBeCloseTo(0.22);
    });
  });

  describe("queries", () => {
    it("gets recent workflows", () => {
      recordWorkflowStart("wf-old", "argyn", "bd-001");
      recordWorkflowStart("wf-new", "argyn", "bd-002");

      const recent = getRecentWorkflows(10);
      expect(recent).toHaveLength(2);
      // Both workflows should be present (order may vary if timestamps are equal)
      const ids = recent.map((w) => w.id);
      expect(ids).toContain("wf-old");
      expect(ids).toContain("wf-new");
    });

    it("limits recent workflows", () => {
      recordWorkflowStart("wf-1", "argyn", "bd-001");
      recordWorkflowStart("wf-2", "argyn", "bd-002");
      recordWorkflowStart("wf-3", "argyn", "bd-003");

      const recent = getRecentWorkflows(2);
      expect(recent).toHaveLength(2);
    });

    it("gets running workflows", () => {
      recordWorkflowStart("wf-running", "argyn", "bd-001");
      recordWorkflowStart("wf-done", "argyn", "bd-002");
      recordWorkflowComplete("wf-done", "done");

      const running = getRunningWorkflows();
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe("wf-running");
    });
  });
});
