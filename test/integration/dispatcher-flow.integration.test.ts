/**
 * Integration tests for dispatcher workflow flow
 *
 * Tests the full workflow: task -> workflow epic -> agent dispatch -> handoff.
 * Uses real beads CLI but mocked Claude SDK.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import {
  initializeWhs,
  loadConfig,
  addProject,
} from "../../src/config.js";
import { beads } from "../../src/beads/index.js";
import {
  startWorkflow,
  getReadyWorkflowSteps,
  createNextStep,
  completeStep,
  completeWorkflow,
  getWorkflowForSource,
} from "../../src/workflow.js";

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

  // Initialize git
  for (const dir of [orchestrator, project]) {
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
    execSync('git config user.name "Test User"', { cwd: dir, stdio: "pipe" });
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

  // Retry rmSync a few times in case of race conditions with file handles
  if (existsSync(dirs.base)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(dirs.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        break;
      } catch (err) {
        if (attempt === 2) {
          // On final attempt, just log and continue - don't fail the test
          console.warn(`Warning: Could not clean up ${dirs.base}: ${err}`);
        }
      }
    }
  }
}

describe("dispatcher workflow flow", () => {
  const allDirs: TestDirs[] = [];
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dirs of allDirs) {
      cleanupTestDirs(dirs);
    }
    allDirs.length = 0;
  });

  it("startWorkflow creates epic and first step in orchestrator", async () => {
    const dirs = createTestDirs("workflow-start");
    allDirs.push(dirs);

    // Initialize
    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Create a task in project beads
    const task = beads.create("Implement feature X", dirs.project, {
      type: "task",
      description: "Add feature X to the system",
    });

    // Change to orchestrator directory (workflow functions use cwd)
    process.chdir(dirs.orchestrator);

    // Start workflow
    const workItem = {
      id: task.id,
      project: "test-project",
      title: task.title,
      description: task.description,
      priority: 2,
      type: "task" as const,
      status: "open" as const,
      labels: [],
      dependencies: [],
    };

    const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

    // Verify epic created
    const epic = beads.show(epicId, dirs.orchestrator);
    expect(epic.type).toBe("epic");
    expect(epic.title).toContain("test-project");
    expect(epic.title).toContain(task.id);
    expect(epic.labels).toContain("project:test-project");
    expect(epic.labels).toContain(`source:${task.id}`);

    // Verify step created
    const step = beads.show(stepId, dirs.orchestrator);
    expect(step.type).toBe("task");
    expect(step.parent).toBe(epicId);
    expect(step.labels).toContain("agent:implementation");
  });

  it("getReadyWorkflowSteps returns open steps", async () => {
    const dirs = createTestDirs("workflow-ready");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const task = beads.create("Test task", dirs.project, { type: "task" });

    process.chdir(dirs.orchestrator);

    const workItem = {
      id: task.id,
      project: "test-project",
      title: task.title,
      description: task.description || "",
      priority: 2,
      type: "task" as const,
      status: "open" as const,
      labels: [],
      dependencies: [],
    };

    const { stepId } = await startWorkflow("test-project", workItem, "implementation");

    // Get ready steps
    const readySteps = getReadyWorkflowSteps();

    expect(readySteps.length).toBeGreaterThanOrEqual(1);
    const foundStep = readySteps.find((s) => s.id === stepId);
    expect(foundStep).toBeDefined();
    expect(foundStep!.agent).toBe("implementation");
  });

  it("createNextStep adds step under workflow epic", async () => {
    const dirs = createTestDirs("workflow-next-step");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const task = beads.create("Test task", dirs.project, { type: "task" });

    process.chdir(dirs.orchestrator);

    const workItem = {
      id: task.id,
      project: "test-project",
      title: task.title,
      description: "",
      priority: 2,
      type: "task" as const,
      status: "open" as const,
      labels: [],
      dependencies: [],
    };

    const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

    // Complete first step
    completeStep(stepId, "PR created, ready for review");

    // Create next step
    const nextStepId = createNextStep(epicId, "quality_review", "Review PR #123", {
      pr_number: 123,
      ci_status: "passed",
    });

    // Verify next step
    const nextStep = beads.show(nextStepId, dirs.orchestrator);
    expect(nextStep.parent).toBe(epicId);
    expect(nextStep.labels).toContain("agent:quality_review");
    expect(nextStep.labels).toContain("pr:123");
    expect(nextStep.labels).toContain("ci:passed");
  });

  it("completeWorkflow closes epic with done status", async () => {
    const dirs = createTestDirs("workflow-complete-done");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const task = beads.create("Test task", dirs.project, { type: "task" });

    process.chdir(dirs.orchestrator);

    const workItem = {
      id: task.id,
      project: "test-project",
      title: task.title,
      description: "",
      priority: 2,
      type: "task" as const,
      status: "open" as const,
      labels: [],
      dependencies: [],
    };

    const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

    // Complete step
    completeStep(stepId, "Done");

    // Complete workflow
    completeWorkflow(epicId, "done", "Feature implemented and merged");

    // Verify epic is closed
    const epic = beads.show(epicId, dirs.orchestrator);
    expect(epic.status).toBe("closed");
  });

  it("completeWorkflow marks epic as blocked", async () => {
    const dirs = createTestDirs("workflow-complete-blocked");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const task = beads.create("Test task", dirs.project, { type: "task" });

    process.chdir(dirs.orchestrator);

    const workItem = {
      id: task.id,
      project: "test-project",
      title: task.title,
      description: "",
      priority: 2,
      type: "task" as const,
      status: "open" as const,
      labels: [],
      dependencies: [],
    };

    const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

    // Complete step
    completeStep(stepId, "Blocked on external dependency");

    // Mark workflow blocked
    completeWorkflow(epicId, "blocked", "Waiting for API key");

    // Verify epic is blocked
    const epic = beads.show(epicId, dirs.orchestrator);
    expect(epic.status).toBe("blocked");
    expect(epic.labels).toContain("blocked:human");
  });

  it("getWorkflowForSource returns existing workflow", async () => {
    const dirs = createTestDirs("workflow-get-existing");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const task = beads.create("Test task", dirs.project, { type: "task" });

    process.chdir(dirs.orchestrator);

    const workItem = {
      id: task.id,
      project: "test-project",
      title: task.title,
      description: "",
      priority: 2,
      type: "task" as const,
      status: "open" as const,
      labels: [],
      dependencies: [],
    };

    const { epicId } = await startWorkflow("test-project", workItem, "implementation");

    // Look up workflow by source
    const workflow = getWorkflowForSource("test-project", task.id);

    expect(workflow).toBeDefined();
    expect(workflow!.id).toBe(epicId);
    expect(workflow!.sourceProject).toBe("test-project");
    expect(workflow!.sourceBeadId).toBe(task.id);
  });

  it("getWorkflowForSource returns null for unknown source", () => {
    const dirs = createTestDirs("workflow-get-unknown");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });

    process.chdir(dirs.orchestrator);

    const workflow = getWorkflowForSource("nonexistent", "fake-id");
    expect(workflow).toBeNull();
  });
});
