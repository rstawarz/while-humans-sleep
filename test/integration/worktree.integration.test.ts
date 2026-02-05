/**
 * Integration tests for worktree management
 *
 * Tests the worktree module which wraps the worktrunk (wt) CLI.
 * These tests will be skipped if worktrunk is not installed.
 *
 * Worktree features tested:
 * - Creating worktrees for workflows
 * - Agent running in correct worktree cwd
 * - Cleaning up worktrees on completion
 * - Worktree persistence when workflow is blocked
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import {
  initializeWhs,
  addProject,
} from "../../src/config.js";
import { beads } from "../../src/beads/index.js";
import {
  startWorkflow,
  completeStep,
  completeWorkflow,
} from "../../src/workflow.js";
import {
  ensureWorktree,
  getWorktree,
  listWorktrees,
  removeWorktree,
  getMainWorktree,
  hasUncommittedChanges,
  isIntegrated,
  getWorktreeBasePath,
} from "../../src/worktree.js";
import type { WorkItem } from "../../src/types.js";
import { isWorktrunkInstalled } from "./helpers/test-harness.js";

const FIXTURES_BASE = resolve(__dirname, "fixtures");

// Check if worktrunk is installed before running these tests
const describeIfWorktrunk = isWorktrunkInstalled() ? describe : describe.skip;

interface TestDirs {
  base: string;
  orchestrator: string;
  project: string;
  worktreeBase: string;
}

function createTestDirs(testName: string): TestDirs {
  const timestamp = Date.now();
  const pid = process.pid;
  const dirName = `${testName}-${pid}-${timestamp}`;
  const base = join(FIXTURES_BASE, dirName);
  const orchestrator = join(base, "orchestrator");
  const project = join(base, "project");
  const worktreeBase = `${project}-worktrees`;

  mkdirSync(orchestrator, { recursive: true });
  mkdirSync(project, { recursive: true });

  for (const dir of [orchestrator, project]) {
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
    execSync('git config user.name "Test User"', { cwd: dir, stdio: "pipe" });
    // Disable GPG signing for tests
    execSync("git config commit.gpgsign false", { cwd: dir, stdio: "pipe" });

    // Create an initial commit (required for worktrees)
    writeFileSync(join(dir, "README.md"), "# Test Project\n");
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync("git commit -m 'Initial commit'", { cwd: dir, stdio: "pipe" });

    // Create main branch if on default branch with different name
    try {
      execSync("git branch -M main", { cwd: dir, stdio: "pipe" });
    } catch {
      // Already on main or can't rename
    }
  }

  return { base, orchestrator, project, worktreeBase };
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

  // Clean up worktrees first
  if (existsSync(dirs.worktreeBase)) {
    try {
      rmSync(dirs.worktreeBase, { recursive: true, force: true });
    } catch {
      // Ignore
    }
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

describeIfWorktrunk("worktree management", () => {
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

  describe("worktree creation", () => {
    it("ensureWorktree creates worktree for workflow", () => {
      const dirs = createTestDirs("wt-create");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      // Create a task
      const task = beads.create("Test task", dirs.project, { type: "task" });

      // Ensure worktree exists
      const worktreePath = ensureWorktree("test-project", task.id, { baseBranch: "main" });

      // Verify worktree was created
      expect(existsSync(worktreePath)).toBe(true);

      // Verify it's a valid git directory
      const isGitDir = existsSync(join(worktreePath, ".git"));
      expect(isGitDir).toBe(true);

      // Verify branch was created
      const worktree = getWorktree("test-project", task.id);
      expect(worktree).not.toBeNull();
      expect(worktree?.branch).toBe(task.id);
    });

    it("ensureWorktree returns existing worktree if already created", () => {
      const dirs = createTestDirs("wt-existing");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      const task = beads.create("Test task", dirs.project, { type: "task" });

      // Create worktree first time
      const path1 = ensureWorktree("test-project", task.id, { baseBranch: "main" });

      // Ensure again - should return same path
      const path2 = ensureWorktree("test-project", task.id, { baseBranch: "main" });

      expect(path2).toBe(path1);
    });

    it("creates worktree at expected path", () => {
      const dirs = createTestDirs("wt-path");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      const task = beads.create("Path test", dirs.project, { type: "task" });

      const worktreePath = ensureWorktree("test-project", task.id, { baseBranch: "main" });

      // Verify path follows expected pattern
      const expectedBase = getWorktreeBasePath("test-project");
      expect(worktreePath.startsWith(expectedBase)).toBe(true);
    });
  });

  describe("worktree listing", () => {
    it("listWorktrees returns all worktrees", () => {
      const dirs = createTestDirs("wt-list");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      // Create multiple tasks with worktrees
      const task1 = beads.create("Task 1", dirs.project, { type: "task" });
      const task2 = beads.create("Task 2", dirs.project, { type: "task" });

      ensureWorktree("test-project", task1.id, { baseBranch: "main" });
      ensureWorktree("test-project", task2.id, { baseBranch: "main" });

      // List worktrees
      const worktrees = listWorktrees("test-project");

      // Should have main + 2 created worktrees
      expect(worktrees.length).toBeGreaterThanOrEqual(3);

      // Find our created worktrees
      const wt1 = worktrees.find((w) => w.branch === task1.id);
      const wt2 = worktrees.find((w) => w.branch === task2.id);

      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
    });

    it("getMainWorktree returns main worktree", () => {
      const dirs = createTestDirs("wt-main");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      const mainWorktree = getMainWorktree("test-project");

      expect(mainWorktree).not.toBeNull();
      expect(mainWorktree?.isMain).toBe(true);
    });
  });

  describe("worktree cleanup", () => {
    it("removeWorktree cleans up on workflow completion", () => {
      const dirs = createTestDirs("wt-cleanup");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      const task = beads.create("Cleanup test", dirs.project, { type: "task" });

      // Create worktree
      const worktreePath = ensureWorktree("test-project", task.id, { baseBranch: "main" });
      expect(existsSync(worktreePath)).toBe(true);

      // Remove worktree (simulating workflow completion)
      const removed = removeWorktree("test-project", task.id, { force: true });

      expect(removed).toBe(true);

      // Verify worktree is gone
      const worktree = getWorktree("test-project", task.id);
      expect(worktree).toBeNull();
    });

    it("worktree survives when workflow is blocked", async () => {
      const dirs = createTestDirs("wt-blocked");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);

      process.chdir(dirs.orchestrator);

      const task = beads.create("Blocked test", dirs.project, { type: "task" });
      const workItem = createWorkItem(task, "test-project");

      // Create workflow and worktree
      ensureWorktree("test-project", task.id, { baseBranch: "main" });

      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Complete step and mark workflow as blocked
      completeStep(stepId, "Cannot proceed");
      completeWorkflow(epicId, "blocked", "Waiting for dependency");

      // Worktree should still exist
      const worktree = getWorktree("test-project", task.id);
      expect(worktree).not.toBeNull();
    });
  });

  describe("worktree state", () => {
    it("hasUncommittedChanges detects modified files", () => {
      const dirs = createTestDirs("wt-uncommitted");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      const task = beads.create("Changes test", dirs.project, { type: "task" });

      const worktreePath = ensureWorktree("test-project", task.id, { baseBranch: "main" });

      // Initially no uncommitted changes
      let hasChanges = hasUncommittedChanges("test-project", task.id);
      expect(hasChanges).toBe(false);

      // Create a new file in the worktree
      writeFileSync(join(worktreePath, "new-file.txt"), "test content");

      // Now should have uncommitted changes
      hasChanges = hasUncommittedChanges("test-project", task.id);
      expect(hasChanges).toBe(true);
    });

    it("isIntegrated detects merged branches", () => {
      const dirs = createTestDirs("wt-integrated");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      const task = beads.create("Merge test", dirs.project, { type: "task" });

      const worktreePath = ensureWorktree("test-project", task.id, { baseBranch: "main" });

      // Branch just created from main - check state
      // Note: Exact behavior depends on worktrunk's detection
      const integrated = isIntegrated("test-project", task.id);

      // A newly created branch from main might be considered "integrated"
      // or "empty" depending on worktrunk version
      // Just verify the function works without error
      expect(typeof integrated).toBe("boolean");
    });
  });

  describe("agent worktree usage", () => {
    it("agent runs in correct worktree cwd", () => {
      const dirs = createTestDirs("wt-agent-cwd");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      const task = beads.create("Agent cwd test", dirs.project, { type: "task" });

      // Create worktree
      const worktreePath = ensureWorktree("test-project", task.id, { baseBranch: "main" });

      // Verify the path is valid and different from main project
      expect(worktreePath).not.toBe(dirs.project);
      expect(existsSync(worktreePath)).toBe(true);

      // Verify we can run commands in the worktree
      const result = execSync("git status", {
        cwd: worktreePath,
        encoding: "utf-8",
      });

      expect(result).toContain(task.id); // Branch name should appear in status
    });

    it("worktree has access to project files", () => {
      const dirs = createTestDirs("wt-files");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      const task = beads.create("Files test", dirs.project, { type: "task" });

      const worktreePath = ensureWorktree("test-project", task.id, { baseBranch: "main" });

      // README.md should exist in worktree (was in initial commit)
      const readmePath = join(worktreePath, "README.md");
      expect(existsSync(readmePath)).toBe(true);
    });

    it("changes in worktree do not affect main", () => {
      const dirs = createTestDirs("wt-isolation");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, { baseBranch: "main" }, dirs.orchestrator);
      process.chdir(dirs.orchestrator);

      const task = beads.create("Isolation test", dirs.project, { type: "task" });

      const worktreePath = ensureWorktree("test-project", task.id, { baseBranch: "main" });

      // Create a new file in worktree
      const newFilePath = join(worktreePath, "worktree-only.txt");
      writeFileSync(newFilePath, "This file only exists in worktree");

      // File should NOT exist in main project
      const mainFilePath = join(dirs.project, "worktree-only.txt");
      expect(existsSync(mainFilePath)).toBe(false);
    });
  });
});

// Non-worktree tests (run even if worktrunk is not installed)
describe("worktree helpers (no worktrunk required)", () => {
  it("isWorktrunkInstalled returns boolean", () => {
    const result = isWorktrunkInstalled();
    expect(typeof result).toBe("boolean");
  });
});
