/**
 * Integration tests for planning workflow
 *
 * Tests the planning workflow pattern where:
 * 1. An epic is created in blocked status
 * 2. A planning task is created under the epic
 * 3. The planning task blocks the epic via dependency
 * 4. When planning completes, the epic unblocks
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import {
  initializeWhs,
  addProject,
} from "../../src/config.js";
import { beads } from "../../src/beads/index.js";

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

describe("planning workflow", () => {
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

  it("creates epic in project beads with blocked status", async () => {
    const dirs = createTestDirs("planning-epic-blocked");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Create epic in project beads (blocked status) - simulating `whs plan` command
    const epic = beads.create("Add user authentication", dirs.project, {
      type: "epic",
      status: "blocked",
      priority: 2,
      description: "Epic for: Add user authentication\n\nCreated via whs plan.",
      labels: ["whs", "needs-planning"],
    });

    // Verify epic was created with correct properties
    expect(epic.type).toBe("epic");
    expect(epic.status).toBe("blocked");
    expect(epic.labels).toContain("whs");
    expect(epic.labels).toContain("needs-planning");
  });

  it("creates planning task under epic", async () => {
    const dirs = createTestDirs("planning-task");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Create epic
    const epic = beads.create("Add authentication", dirs.project, {
      type: "epic",
      status: "blocked",
      labels: ["whs", "needs-planning"],
    });

    // Create planning task under the epic (open status)
    const planningTask = beads.create("Plan: Add authentication", dirs.project, {
      type: "task",
      status: "open",
      priority: 2,
      parent: epic.id,
      description: "Planning task for authentication feature.",
      labels: ["whs", "planning", "agent:planner"],
    });

    // Verify planning task
    expect(planningTask.type).toBe("task");
    expect(planningTask.status).toBe("open");
    expect(planningTask.parent).toBe(epic.id);
    expect(planningTask.labels).toContain("planning");
    expect(planningTask.labels).toContain("agent:planner");
  });

  it("planning task blocks epic via dependency", async () => {
    const dirs = createTestDirs("planning-dep");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Create epic (blocked status, no parent relationship with planning task to avoid cycle)
    const epic = beads.create("Feature with planning", dirs.project, {
      type: "epic",
      status: "blocked",
      labels: ["whs", "needs-planning"],
    });

    // Create planning task (without parent relationship to avoid dependency cycle)
    const planningTask = beads.create("Plan: Feature", dirs.project, {
      type: "task",
      status: "open",
      labels: ["whs", "planning", "agent:planner", `epic:${epic.id}`],
    });

    // Add dependency: epic is blocked by planning task
    beads.depAdd(epic.id, planningTask.id, dirs.project);

    // Verify epic has the dependency (could be string or object with id)
    const updatedEpic = beads.show(epic.id, dirs.project);
    const hasDep = updatedEpic.dependencies.some((d: string | { id: string }) =>
      typeof d === "string" ? d === planningTask.id : d.id === planningTask.id
    );
    expect(hasDep).toBe(true);

    // Epic should NOT appear in ready list (blocked status)
    const readyBeads = beads.ready(dirs.project);
    const epicInReady = readyBeads.find((b) => b.id === epic.id);
    expect(epicInReady).toBeUndefined();

    // Planning task SHOULD appear in ready list
    const planningInReady = readyBeads.find((b) => b.id === planningTask.id);
    expect(planningInReady).toBeDefined();
  });

  it("when planning task closes, epic unblocks", async () => {
    const dirs = createTestDirs("planning-unblock");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Create epic (blocked, no parent relationship to avoid cycle)
    const epic = beads.create("Feature to unblock", dirs.project, {
      type: "epic",
      status: "blocked",
      labels: ["whs", "needs-planning"],
    });

    // Create planning task (no parent to avoid cycle)
    const planningTask = beads.create("Plan: Feature", dirs.project, {
      type: "task",
      status: "open",
      labels: ["whs", "planning", "agent:planner", `epic:${epic.id}`],
    });

    // Add dependency
    beads.depAdd(epic.id, planningTask.id, dirs.project);

    // Initially, epic should NOT be in ready list (blocked status)
    let readyBeads = beads.ready(dirs.project);
    expect(readyBeads.find((b) => b.id === epic.id)).toBeUndefined();

    // Close the planning task
    beads.close(planningTask.id, "Planning complete", dirs.project);

    // Also update epic status from blocked to open
    beads.update(epic.id, dirs.project, { status: "open" });

    // Now epic SHOULD be in ready list (dependency is closed)
    readyBeads = beads.ready(dirs.project);
    const epicInReady = readyBeads.find((b) => b.id === epic.id);
    expect(epicInReady).toBeDefined();
  });

  it("planning task creates implementation subtasks", async () => {
    const dirs = createTestDirs("planning-subtasks");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Create epic (no children to avoid dependency cycles)
    const epic = beads.create("Feature with subtasks", dirs.project, {
      type: "epic",
      status: "blocked",
    });

    // Create planning task (no parent to avoid cycle)
    const planningTask = beads.create("Plan: Feature", dirs.project, {
      type: "task",
      status: "open",
      labels: ["planning", `epic:${epic.id}`],
    });

    // Simulate planner agent creating subtasks (no parent relationship)
    const subtask1 = beads.create("Implement auth service", dirs.project, {
      type: "task",
      status: "blocked",
      labels: [`epic:${epic.id}`],
    });

    const subtask2 = beads.create("Add auth tests", dirs.project, {
      type: "task",
      status: "blocked",
      labels: [`epic:${epic.id}`],
    });

    const subtask3 = beads.create("Auth documentation", dirs.project, {
      type: "task",
      status: "blocked",
      labels: [`epic:${epic.id}`],
    });

    // Add dependencies: subtask1 blocked by planning, subtask2 by subtask1, etc.
    beads.depAdd(subtask1.id, planningTask.id, dirs.project);
    beads.depAdd(subtask2.id, subtask1.id, dirs.project);
    beads.depAdd(subtask3.id, subtask2.id, dirs.project);

    // Only planning task should be ready
    let readyBeads = beads.ready(dirs.project);
    expect(readyBeads.map((b) => b.id)).toContain(planningTask.id);
    expect(readyBeads.map((b) => b.id)).not.toContain(subtask1.id);
    expect(readyBeads.map((b) => b.id)).not.toContain(subtask2.id);

    // Close planning task and unblock subtask1
    beads.close(planningTask.id, "Planning done", dirs.project);
    beads.update(subtask1.id, dirs.project, { status: "open" });

    // Now subtask1 should be ready
    readyBeads = beads.ready(dirs.project);
    expect(readyBeads.map((b) => b.id)).toContain(subtask1.id);
    expect(readyBeads.map((b) => b.id)).not.toContain(subtask2.id);

    // Close subtask1 and unblock subtask2
    beads.close(subtask1.id, "Auth service implemented", dirs.project);
    beads.update(subtask2.id, dirs.project, { status: "open" });

    readyBeads = beads.ready(dirs.project);
    expect(readyBeads.map((b) => b.id)).toContain(subtask2.id);
  });

  it("planning task with questions pattern", async () => {
    const dirs = createTestDirs("planning-questions");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Create epic
    const epic = beads.create("Feature needing clarification", dirs.project, {
      type: "epic",
      status: "blocked",
    });

    // Create planning task (no parent to avoid cycle)
    const planningTask = beads.create("Plan: Feature", dirs.project, {
      type: "task",
      status: "open",
      labels: ["planning", "agent:planner", `epic:${epic.id}`],
    });

    // Simulate planner asking questions by adding comments
    // Comments may or may not be returned by beads.show depending on beads version
    // Just verify the comment operations don't throw
    expect(() => {
      beads.comment(planningTask.id, "Need clarification: Should we use JWT or sessions for auth?", dirs.project);
      beads.comment(planningTask.id, "Question: What's the expected user load?", dirs.project);
    }).not.toThrow();

    // Verify task is still in expected state
    const task = beads.show(planningTask.id, dirs.project);
    expect(task.status).toBe("open");
    expect(task.labels).toContain("planning");
  });

  it("full planning workflow simulation", async () => {
    const dirs = createTestDirs("planning-full");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Step 1: User runs `whs plan argyn "add user authentication"`
    const epic = beads.create("Add user authentication", dirs.project, {
      type: "epic",
      status: "blocked",
      priority: 2,
      description: "Epic for: Add user authentication\n\nCreated via whs plan.",
      labels: ["whs", "needs-planning"],
    });

    // Planning task without parent relationship (use label to track epic)
    const planningTask = beads.create("Plan: Add user authentication", dirs.project, {
      type: "task",
      status: "open",
      priority: 2,
      description: "Planning task - will be picked up by planner agent.",
      labels: ["whs", "planning", "agent:planner", `epic:${epic.id}`],
    });

    // Step 2: Verify planning task is ready for dispatch
    let readyBeads = beads.ready(dirs.project);
    expect(readyBeads.map((b) => b.id)).toContain(planningTask.id);

    // Step 3: Planner runs and creates subtasks (without parent relationship)
    const impl = beads.create("Implement JWT auth service", dirs.project, {
      type: "task",
      status: "blocked",
      description: "Create auth service using JWT tokens.",
      labels: [`epic:${epic.id}`],
    });

    const tests = beads.create("Add auth tests", dirs.project, {
      type: "task",
      status: "blocked",
      description: "Add unit and integration tests for auth.",
      labels: [`epic:${epic.id}`],
    });

    const docs = beads.create("Update auth documentation", dirs.project, {
      type: "task",
      status: "blocked",
      description: "Document the auth flow and API endpoints.",
      labels: [`epic:${epic.id}`],
    });

    // Set up dependency chain (task dependencies, not parent-child)
    beads.depAdd(impl.id, planningTask.id, dirs.project);
    beads.depAdd(tests.id, impl.id, dirs.project);
    beads.depAdd(docs.id, tests.id, dirs.project);

    // Step 4: Planner completes and closes planning task
    beads.close(planningTask.id, "Planning complete. Created 3 subtasks.", dirs.project);

    // Step 5: First implementation task becomes ready
    beads.update(impl.id, dirs.project, { status: "open" });
    readyBeads = beads.ready(dirs.project);
    expect(readyBeads.map((b) => b.id)).toContain(impl.id);

    // Step 6: Implementation completes
    beads.close(impl.id, "JWT auth service implemented", dirs.project);
    beads.update(tests.id, dirs.project, { status: "open" });

    // Step 7: Tests complete
    beads.close(tests.id, "All tests passing", dirs.project);
    beads.update(docs.id, dirs.project, { status: "open" });

    // Step 8: Docs complete
    beads.close(docs.id, "Documentation updated", dirs.project);

    // Step 9: All subtasks done, epic can be closed
    beads.update(epic.id, dirs.project, { status: "open" });
    beads.close(epic.id, "Feature complete", dirs.project);

    // Verify final state
    const finalEpic = beads.show(epic.id, dirs.project);
    expect(finalEpic.status).toBe("closed");

    // All subtasks should be closed
    const finalImpl = beads.show(impl.id, dirs.project);
    const finalTests = beads.show(tests.id, dirs.project);
    const finalDocs = beads.show(docs.id, dirs.project);
    expect(finalImpl.status).toBe("closed");
    expect(finalTests.status).toBe("closed");
    expect(finalDocs.status).toBe("closed");
  });

  it("avoids dependency cycle by not using parent relationship", async () => {
    // This test verifies the fix for the cycle bug:
    // When planning task has parent: epic.id, adding depAdd(epic.id, planningTask.id)
    // creates a cycle because:
    // - epic -> planningTask (via parent relationship)
    // - planningTask -> epic (via explicit dependency we're adding)
    //
    // The fix: use labels instead of parent to track epic association

    const dirs = createTestDirs("planning-no-cycle");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Create epic
    const epic = beads.create("Feature needing planning", dirs.project, {
      type: "epic",
      status: "blocked",
      labels: ["whs", "needs-planning"],
    });

    // CORRECT: Create planning task WITHOUT parent, using label to track epic
    const planningTask = beads.create("Plan: Feature", dirs.project, {
      type: "task",
      status: "open",
      labels: ["whs", "planning", "agent:planner", `epic:${epic.id}`],
      // Note: NO parent: epic.id here - that would cause a cycle!
    });

    // This should NOT throw - no cycle because no parent relationship
    expect(() => {
      beads.depAdd(epic.id, planningTask.id, dirs.project);
    }).not.toThrow();

    // Verify the epic association is tracked via label
    const fetchedTask = beads.show(planningTask.id, dirs.project);
    expect(fetchedTask.labels).toContain(`epic:${epic.id}`);

    // Verify dependency was added successfully
    const updatedEpic = beads.show(epic.id, dirs.project);
    const hasDep = updatedEpic.dependencies.some((d: string | { id: string }) =>
      typeof d === "string" ? d === planningTask.id : d.id === planningTask.id
    );
    expect(hasDep).toBe(true);
  });

  it("parent relationship with dependency causes cycle error", async () => {
    // This test documents the BUG that existed before the fix:
    // Creating a task with parent: epic.id, then adding epic -> task dependency
    // creates a cycle and throws an error.
    //
    // This test serves as a regression test to ensure we don't reintroduce
    // the pattern that causes cycles.

    const dirs = createTestDirs("planning-cycle-bug");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    beads.init(dirs.orchestrator, { prefix: "orc" });
    beads.init(dirs.project, { prefix: "proj" });
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Create epic
    const epic = beads.create("Feature with cycle bug", dirs.project, {
      type: "epic",
      status: "blocked",
    });

    // BUG PATTERN: Create task WITH parent relationship
    const taskWithParent = beads.create("Plan: Feature", dirs.project, {
      type: "task",
      status: "open",
      parent: epic.id, // <-- This creates epic -> task relationship
    });

    // Attempting to add dependency: epic blocked by task
    // This creates: task -> epic (from parent) AND epic -> task (from dep)
    // Result: CYCLE!
    expect(() => {
      beads.depAdd(epic.id, taskWithParent.id, dirs.project);
    }).toThrow(/cycle/i);
  });
});
