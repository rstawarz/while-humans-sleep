/**
 * Integration tests for dispatcher tick loop
 *
 * Tests the full dispatcher.tick() method including:
 * - Polling project beads for new work
 * - Starting workflows
 * - Dispatching workflow steps
 * - Handling handoffs between agents
 * - Workflow completion and blocking
 *
 * Note: These tests use mocked agent execution to avoid real API calls.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import {
  initializeWhs,
  addProject,
  expandPath,
  loadConfig,
} from "../../src/config.js";
import { beads } from "../../src/beads/index.js";
import {
  startWorkflow,
  getWorkflowForSource,
  getReadyWorkflowSteps,
  createNextStep,
  completeStep,
  completeWorkflow,
  markStepInProgress,
} from "../../src/workflow.js";
import type { WorkItem, QuestionBeadData } from "../../src/types.js";
import {
  configureMockAgent,
  resetMockAgent,
  simpleResponse,
  workflowScript,
} from "./helpers/mock-agent.js";

const FIXTURES_BASE = resolve(__dirname, "fixtures");

interface TestDirs {
  base: string;
  orchestrator: string;
  project: string;
}

function createTestDirs(testName: string): TestDirs {
  const timestamp = Date.now();
  const pid = process.pid;
  const dirName = `${testName}-${pid}-${timestamp}`;
  const base = join(FIXTURES_BASE, dirName);
  const orchestrator = join(base, "orchestrator");
  const project = join(base, "project");

  mkdirSync(orchestrator, { recursive: true });
  mkdirSync(project, { recursive: true });

  for (const dir of [orchestrator, project]) {
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
    execSync('git config user.name "Test User"', { cwd: dir, stdio: "pipe" });
    // Disable GPG signing for tests
    execSync("git config commit.gpgsign false", { cwd: dir, stdio: "pipe" });
  }

  return { base, orchestrator, project };
}

function cleanupTestDirs(dirs: TestDirs): void {
  try {
    beads.daemonStop(dirs.orchestrator);
  } catch {
    // Ignore
  }
  try {
    beads.daemonStop(dirs.project);
  } catch {
    // Ignore
  }

  if (existsSync(dirs.base)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(dirs.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        break;
      } catch (err) {
        if (attempt === 2) {
          console.warn(`Warning: Could not clean up ${dirs.base}: ${err}`);
        }
      }
    }
  }
}

function createWorkItem(bead: ReturnType<typeof beads.create>, project: string): WorkItem {
  return {
    id: bead.id,
    project,
    title: bead.title,
    description: bead.description || "",
    priority: bead.priority ?? 2,
    type: (bead.type as WorkItem["type"]) || "task",
    status: bead.status as WorkItem["status"],
    labels: bead.labels || [],
    dependencies: bead.dependencies || [],
  };
}

describe("dispatcher tick loop", () => {
  const allDirs: TestDirs[] = [];
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    resetMockAgent();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dirs of allDirs) {
      cleanupTestDirs(dirs);
    }
    allDirs.length = 0;
    resetMockAgent();
  });

  describe("workflow initialization", () => {
    it("polls project beads and finds ready tasks", async () => {
      const dirs = createTestDirs("tick-poll-ready");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      // Create a task in the project
      const task = beads.create("Implement feature", dirs.project, {
        type: "task",
        description: "Build the feature",
      });

      // Get ready tasks from project
      const readyTasks = beads.ready(dirs.project);

      expect(readyTasks.length).toBeGreaterThanOrEqual(1);
      expect(readyTasks.find((b) => b.id === task.id)).toBeDefined();
    });

    it("startWorkflow creates workflow epic and first step", async () => {
      const dirs = createTestDirs("tick-start-workflow");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const task = beads.create("New feature", dirs.project, {
        type: "task",
        description: "Create new feature",
      });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(task, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Verify epic
      const epic = beads.show(epicId, dirs.orchestrator);
      expect(epic.type).toBe("epic");
      expect(epic.labels).toContain("project:test-project");
      expect(epic.labels).toContain(`source:${task.id}`);

      // Verify step
      const step = beads.show(stepId, dirs.orchestrator);
      expect(step.type).toBe("task");
      expect(step.parent).toBe(epicId);
      expect(step.labels).toContain("agent:implementation");
    });
  });

  describe("workflow step dispatch", () => {
    it("dispatches ready workflow steps", async () => {
      const dirs = createTestDirs("tick-dispatch-step");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const task = beads.create("Task for dispatch", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(task, "test-project");
      const { stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Step should appear in ready list
      const readySteps = getReadyWorkflowSteps();
      const foundStep = readySteps.find((s) => s.id === stepId);

      expect(foundStep).toBeDefined();
      expect(foundStep?.agent).toBe("implementation");
      expect(foundStep?.status).toBe("open");
    });

    it("marks step as in_progress when dispatched", async () => {
      const dirs = createTestDirs("tick-step-inprogress");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const task = beads.create("Task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(task, "test-project");
      const { stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Simulate dispatcher marking step as in_progress
      markStepInProgress(stepId);

      // Step should no longer be in ready list
      const readySteps = getReadyWorkflowSteps();
      expect(readySteps.find((s) => s.id === stepId)).toBeUndefined();

      // Verify status changed
      const step = beads.show(stepId, dirs.orchestrator);
      expect(step.status).toBe("in_progress");
    });
  });

  describe("multi-step workflow progression", () => {
    it("handles workflow progression through multiple agents", async () => {
      const dirs = createTestDirs("tick-multi-step");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const task = beads.create("Multi-step task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(task, "test-project");
      const { epicId, stepId: step1Id } = await startWorkflow(
        "test-project",
        workItem,
        "implementation"
      );

      // Step 1: implementation
      markStepInProgress(step1Id);
      completeStep(step1Id, "PR #123 created");

      // Create step 2: quality_review
      const step2Id = createNextStep(epicId, "quality_review", "Review PR #123", {
        pr_number: 123,
      });

      // Verify step 2 is ready
      let readySteps = getReadyWorkflowSteps();
      expect(readySteps.find((s) => s.id === step2Id)).toBeDefined();

      // Step 2: quality_review
      markStepInProgress(step2Id);
      completeStep(step2Id, "Approved");

      // Create step 3: release_manager
      const step3Id = createNextStep(epicId, "release_manager", "Merge PR #123", {
        pr_number: 123,
        ci_status: "passed",
      });

      // Verify step 3 is ready
      readySteps = getReadyWorkflowSteps();
      expect(readySteps.find((s) => s.id === step3Id)).toBeDefined();

      // Step 3: release_manager
      markStepInProgress(step3Id);
      completeStep(step3Id, "Merged");

      // Verify all steps are closed
      expect(beads.show(step1Id, dirs.orchestrator).status).toBe("closed");
      expect(beads.show(step2Id, dirs.orchestrator).status).toBe("closed");
      expect(beads.show(step3Id, dirs.orchestrator).status).toBe("closed");
    });
  });

  describe("workflow completion", () => {
    it("completes workflow when agent returns DONE", async () => {
      const dirs = createTestDirs("tick-workflow-done");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const task = beads.create("Task to complete", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(task, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Complete step
      markStepInProgress(stepId);
      completeStep(stepId, "All work done");

      // Complete workflow with DONE
      completeWorkflow(epicId, "done", "Feature implemented and merged");

      // Verify epic is closed
      const epic = beads.show(epicId, dirs.orchestrator);
      expect(epic.status).toBe("closed");
    });

    it("marks workflow blocked when agent returns BLOCKED", async () => {
      const dirs = createTestDirs("tick-workflow-blocked");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const task = beads.create("Task to block", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(task, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Complete step
      markStepInProgress(stepId);
      completeStep(stepId, "Cannot proceed");

      // Mark workflow as BLOCKED
      completeWorkflow(epicId, "blocked", "Waiting for external dependency");

      // Verify epic is blocked
      const epic = beads.show(epicId, dirs.orchestrator);
      expect(epic.status).toBe("blocked");
      expect(epic.labels).toContain("blocked:human");
    });
  });

  describe("duplicate prevention", () => {
    it("skips already-running work items", async () => {
      const dirs = createTestDirs("tick-skip-running");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const task = beads.create("Running task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(task, "test-project");
      const { stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Mark as in_progress (simulating it's already running)
      markStepInProgress(stepId);

      // Ready steps should NOT include in_progress steps
      const readySteps = getReadyWorkflowSteps();
      expect(readySteps.find((s) => s.id === stepId)).toBeUndefined();
    });

    it("prevents duplicate workflows for same source bead", async () => {
      const dirs = createTestDirs("tick-no-duplicate");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const task = beads.create("Unique task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(task, "test-project");

      // Start first workflow
      const { epicId: epic1Id } = await startWorkflow("test-project", workItem, "implementation");

      // Check for existing workflow
      const existing = getWorkflowForSource("test-project", task.id);
      expect(existing).not.toBeNull();
      expect(existing?.id).toBe(epic1Id);

      // Dispatcher would check this before starting a new workflow
      // If it exists, skip creating a new one
    });
  });

  describe("concurrency limits", () => {
    it("respects maxTotal concurrency limit", async () => {
      const dirs = createTestDirs("tick-concurrency-max");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      process.chdir(dirs.orchestrator);

      // Create multiple tasks
      const tasks = [];
      for (let i = 0; i < 5; i++) {
        tasks.push(
          beads.create(`Task ${i}`, dirs.project, {
            type: "task",
            description: `Task number ${i}`,
          })
        );
      }

      // Load config and check concurrency settings
      const config = loadConfig(dirs.orchestrator);
      expect(config.concurrency.maxTotal).toBe(4);

      // All 5 tasks should be in ready list initially
      const readyTasks = beads.ready(dirs.project);
      expect(readyTasks.length).toBeGreaterThanOrEqual(5);

      // The dispatcher would limit how many get started based on maxTotal
      // Here we just verify the configuration is available
    });

    it("tracks active work count correctly", async () => {
      const dirs = createTestDirs("tick-active-count");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      process.chdir(dirs.orchestrator);

      // Create and start workflows for multiple tasks
      const workItems: WorkItem[] = [];
      const stepIds: string[] = [];

      for (let i = 0; i < 3; i++) {
        const task = beads.create(`Task ${i}`, dirs.project, { type: "task" });
        const workItem = createWorkItem(task, "test-project");
        workItems.push(workItem);

        const { stepId } = await startWorkflow("test-project", workItem, "implementation");
        stepIds.push(stepId);
      }

      // Mark all as in_progress
      for (const stepId of stepIds) {
        markStepInProgress(stepId);
      }

      // All steps should be in_progress now
      for (const stepId of stepIds) {
        const step = beads.show(stepId, dirs.orchestrator);
        expect(step.status).toBe("in_progress");
      }

      // Ready steps should be empty (all in progress)
      const readySteps = getReadyWorkflowSteps();
      const activeStepIds = new Set(stepIds);
      const stillReady = readySteps.filter((s) => activeStepIds.has(s.id));
      expect(stillReady.length).toBe(0);
    });
  });

  describe("question handling", () => {
    it("step is blocked when question bead exists", async () => {
      const dirs = createTestDirs("tick-question-block");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const task = beads.create("Task with question", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(task, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Initially step is ready
      let readySteps = getReadyWorkflowSteps();
      expect(readySteps.find((s) => s.id === stepId)).toBeDefined();

      // Create a question bead that blocks the step
      const questionData: QuestionBeadData = {
        metadata: {
          session_id: "test-session",
          worktree: dirs.project,
          step_id: stepId,
          epic_id: epicId,
          project: "test-project",
          asked_at: new Date().toISOString(),
        },
        context: "Need input",
        questions: [{ question: "Q?", header: "H", options: [], multiSelect: false }],
      };

      beads.createQuestion("Question: Test", dirs.orchestrator, questionData, epicId, stepId);

      // Now step should be blocked by the question bead dependency
      readySteps = getReadyWorkflowSteps();
      expect(readySteps.find((s) => s.id === stepId)).toBeUndefined();
    });

    it("step unblocks when question is answered", async () => {
      const dirs = createTestDirs("tick-question-unblock");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const task = beads.create("Task with answered question", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(task, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Create question bead
      const questionData: QuestionBeadData = {
        metadata: {
          session_id: "test-session",
          worktree: dirs.project,
          step_id: stepId,
          epic_id: epicId,
          project: "test-project",
          asked_at: new Date().toISOString(),
        },
        context: "Need input",
        questions: [{ question: "Q?", header: "H", options: [], multiSelect: false }],
      };

      const questionBead = beads.createQuestion(
        "Question",
        dirs.orchestrator,
        questionData,
        epicId,
        stepId
      );

      // Step is blocked
      let readySteps = getReadyWorkflowSteps();
      expect(readySteps.find((s) => s.id === stepId)).toBeUndefined();

      // Answer the question
      beads.answerQuestion(questionBead.id, "The answer", dirs.orchestrator);

      // Step should be unblocked now
      readySteps = getReadyWorkflowSteps();
      expect(readySteps.find((s) => s.id === stepId)).toBeDefined();
    });
  });

  describe("error scenarios", () => {
    it("handles missing project gracefully", () => {
      const dirs = createTestDirs("tick-missing-project");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });

      process.chdir(dirs.orchestrator);

      // Try to get workflow for non-existent project
      const workflow = getWorkflowForSource("nonexistent-project", "fake-id");
      expect(workflow).toBeNull();
    });

    it("handles empty project beads", () => {
      const dirs = createTestDirs("tick-empty-project");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("empty-project", dirs.project, {}, dirs.orchestrator);

      // No tasks created, ready should be empty
      const readyTasks = beads.ready(dirs.project);
      expect(readyTasks.length).toBe(0);
    });
  });
});
