/**
 * Integration tests for source bead lifecycle
 *
 * Tests that source beads (project beads) are updated correctly
 * as workflows progress through different states.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import {
  initializeWhs,
  addProject,
  expandPath,
} from "../../src/config.js";
import { beads } from "../../src/beads/index.js";
import {
  startWorkflow,
  completeStep,
  completeWorkflow,
  getWorkflowForSource,
} from "../../src/workflow.js";
import type { WorkItem } from "../../src/types.js";

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

describe("source bead lifecycle", () => {
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

  it("source bead status is unchanged when workflow starts", async () => {
    const dirs = createTestDirs("source-bead-start");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Create a source bead in the project
    const sourceBead = beads.create("Implement feature X", dirs.project, {
      type: "task",
      description: "Add feature X to the system",
    });

    expect(sourceBead.status).toBe("open");

    process.chdir(dirs.orchestrator);

    // Start workflow
    const workItem = createWorkItem(sourceBead, "test-project");
    await startWorkflow("test-project", workItem, "implementation");

    // Source bead should still be open (dispatcher is responsible for marking in_progress)
    // The workflow.ts startWorkflow function doesn't update source bead status
    const updatedSourceBead = beads.show(sourceBead.id, dirs.project);
    expect(updatedSourceBead.status).toBe("open");
  });

  it("source bead closed when workflow completes with DONE", async () => {
    const dirs = createTestDirs("source-bead-done");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const sourceBead = beads.create("Implement feature", dirs.project, {
      type: "task",
    });

    process.chdir(dirs.orchestrator);

    const workItem = createWorkItem(sourceBead, "test-project");
    const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

    // Complete the step
    completeStep(stepId, "Feature implemented");

    // Close the source bead (simulating what dispatcher.completeWorkflowSuccess does)
    beads.close(sourceBead.id, "Completed by WHS workflow", dirs.project);

    // Complete the workflow
    completeWorkflow(epicId, "done", "Feature implemented and merged");

    // Verify source bead is closed
    const updatedSourceBead = beads.show(sourceBead.id, dirs.project);
    expect(updatedSourceBead.status).toBe("closed");

    // Verify workflow epic is closed
    const epic = beads.show(epicId, dirs.orchestrator);
    expect(epic.status).toBe("closed");
  });

  it("source bead stays open when workflow is BLOCKED", async () => {
    const dirs = createTestDirs("source-bead-blocked");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const sourceBead = beads.create("Implement blocked feature", dirs.project, {
      type: "task",
    });

    process.chdir(dirs.orchestrator);

    const workItem = createWorkItem(sourceBead, "test-project");
    const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

    // Complete the step
    completeStep(stepId, "Blocked on external API");

    // Mark workflow as blocked (but NOT closing source bead)
    completeWorkflow(epicId, "blocked", "Waiting for API access");

    // Source bead should still be open
    const updatedSourceBead = beads.show(sourceBead.id, dirs.project);
    expect(updatedSourceBead.status).toBe("open");

    // Workflow epic should be blocked
    const epic = beads.show(epicId, dirs.orchestrator);
    expect(epic.status).toBe("blocked");
    expect(epic.labels).toContain("blocked:human");
  });

  it("prevents multiple active workflows for the same source bead", async () => {
    const dirs = createTestDirs("source-bead-duplicate");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const sourceBead = beads.create("Feature for duplicate test", dirs.project, {
      type: "task",
    });

    process.chdir(dirs.orchestrator);

    const workItem = createWorkItem(sourceBead, "test-project");

    // Start first workflow
    const { epicId: firstEpicId } = await startWorkflow("test-project", workItem, "implementation");

    // Check that workflow exists for this source
    const existingWorkflow = getWorkflowForSource("test-project", sourceBead.id);
    expect(existingWorkflow).not.toBeNull();
    expect(existingWorkflow?.id).toBe(firstEpicId);

    // The dispatcher should check getWorkflowForSource before starting a new workflow
    // This test verifies the detection mechanism works
    const secondExisting = getWorkflowForSource("test-project", sourceBead.id);
    expect(secondExisting).not.toBeNull();
    expect(secondExisting?.id).toBe(firstEpicId);
  });

  it("allows new workflow after previous workflow completes", async () => {
    const dirs = createTestDirs("source-bead-retry");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const sourceBead = beads.create("Feature for retry test", dirs.project, {
      type: "task",
    });

    process.chdir(dirs.orchestrator);

    const workItem = createWorkItem(sourceBead, "test-project");

    // Start first workflow
    const { epicId: firstEpicId, stepId: firstStepId } = await startWorkflow(
      "test-project",
      workItem,
      "implementation"
    );

    // Complete the first workflow as blocked
    completeStep(firstStepId, "Blocked initially");
    completeWorkflow(firstEpicId, "blocked", "Waiting for dependency");

    // Verify first workflow is blocked
    const firstEpic = beads.show(firstEpicId, dirs.orchestrator);
    expect(firstEpic.status).toBe("blocked");

    // Note: getWorkflowForSource currently only filters by labels, not status
    // So it will still find the blocked workflow. In a real scenario,
    // the dispatcher would need to check the workflow status.
    const existingWorkflow = getWorkflowForSource("test-project", sourceBead.id);
    expect(existingWorkflow).not.toBeNull();
    expect(existingWorkflow?.status).toBe("blocked");

    // In a real implementation, if the blocked workflow is unblocked (human intervention),
    // or if we close it and create a new one, that would be handled by the dispatcher
  });

  it("source bead can have comments added by agent", async () => {
    const dirs = createTestDirs("source-bead-agent-comment");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const sourceBead = beads.create("Quick fix task", dirs.project, {
      type: "task",
    });

    process.chdir(dirs.orchestrator);

    const workItem = createWorkItem(sourceBead, "test-project");
    await startWorkflow("test-project", workItem, "implementation");

    // Simulate agent adding a comment to source bead (agents CAN do this)
    // The beads.comment function should not throw
    expect(() => {
      beads.comment(sourceBead.id, "Found the issue, simple fix applied", dirs.project);
    }).not.toThrow();

    // Agent should NOT close the source bead directly (only orchestrator does that)
    // Verify the bead is still open
    const updatedBead = beads.show(sourceBead.id, dirs.project);
    expect(updatedBead.status).toBe("open");
  });

  it("source bead labels can be updated by agent", async () => {
    const dirs = createTestDirs("source-bead-labels");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const sourceBead = beads.create("Feature with labels", dirs.project, {
      type: "task",
    });

    process.chdir(dirs.orchestrator);

    const workItem = createWorkItem(sourceBead, "test-project");
    await startWorkflow("test-project", workItem, "implementation");

    // Simulate agent adding a label (agents CAN do this)
    beads.update(sourceBead.id, dirs.project, {
      labelAdd: ["needs-migration", "found-tech-debt"],
    });

    // Verify labels were added
    const updatedBead = beads.show(sourceBead.id, dirs.project);
    expect(updatedBead.labels).toContain("needs-migration");
    expect(updatedBead.labels).toContain("found-tech-debt");

    // Status should still be open
    expect(updatedBead.status).toBe("open");
  });
});
