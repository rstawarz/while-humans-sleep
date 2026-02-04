/**
 * Integration tests for whs add command
 *
 * Tests that adding projects works correctly with real beads CLI.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import {
  initializeWhs,
  loadConfig,
  addProject,
  getProject,
  listProjects,
  removeProject,
} from "../../src/config.js";
import { beads } from "../../src/beads/index.js";

const FIXTURES_BASE = resolve(__dirname, "fixtures");

interface TestDirs {
  base: string;
  orchestrator: string;
  project: string;
}

// Helper to create test directories
function createTestDirs(testName: string): TestDirs {
  const timestamp = Date.now();
  const pid = process.pid;
  const dirName = `${testName}-${pid}-${timestamp}`;
  const base = join(FIXTURES_BASE, dirName);
  const orchestrator = join(base, "orchestrator");
  const project = join(base, "project");

  mkdirSync(orchestrator, { recursive: true });
  mkdirSync(project, { recursive: true });

  // Initialize git in project (required for beads)
  execSync("git init", { cwd: project, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: project, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: project, stdio: "pipe" });

  return { base, orchestrator, project };
}

// Helper to cleanup
function cleanupTestDirs(dirs: TestDirs): void {
  // Stop beads daemons
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
    rmSync(dirs.base, { recursive: true, force: true });
  }
}

describe("whs add project", () => {
  const allDirs: TestDirs[] = [];

  afterEach(() => {
    for (const dirs of allDirs) {
      cleanupTestDirs(dirs);
    }
    allDirs.length = 0;
  });

  it("adds project to config", () => {
    const dirs = createTestDirs("add-basic");
    allDirs.push(dirs);

    // Initialize orchestrator
    initializeWhs(dirs.orchestrator);

    // Add project
    const added = addProject(
      "test-project",
      dirs.project,
      { baseBranch: "main" },
      dirs.orchestrator
    );

    expect(added).toBe(true);

    // Verify in config
    const config = loadConfig(dirs.orchestrator);
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].name).toBe("test-project");
    expect(config.projects[0].repoPath).toBe(dirs.project);
  });

  it("returns false if project already exists", () => {
    const dirs = createTestDirs("add-duplicate");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);

    // Add once
    const first = addProject("test-project", dirs.project, {}, dirs.orchestrator);
    expect(first).toBe(true);

    // Add again with same name
    const second = addProject("test-project", "/some/other/path", {}, dirs.orchestrator);
    expect(second).toBe(false);

    // Only one project in config
    const projects = listProjects(dirs.orchestrator);
    expect(projects).toHaveLength(1);
  });

  it("getProject returns project by name", () => {
    const dirs = createTestDirs("add-get-project");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    addProject(
      "my-project",
      dirs.project,
      { baseBranch: "develop", beadsMode: "stealth" },
      dirs.orchestrator
    );

    const project = getProject("my-project", dirs.orchestrator);

    expect(project).toBeDefined();
    expect(project!.name).toBe("my-project");
    expect(project!.baseBranch).toBe("develop");
    expect(project!.beadsMode).toBe("stealth");
  });

  it("getProject returns undefined for unknown project", () => {
    const dirs = createTestDirs("add-get-unknown");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);

    const project = getProject("nonexistent", dirs.orchestrator);
    expect(project).toBeUndefined();
  });

  it("removeProject removes from config", () => {
    const dirs = createTestDirs("add-remove");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    // Verify added
    expect(listProjects(dirs.orchestrator)).toContain("test-project");

    // Remove
    const removed = removeProject("test-project", dirs.orchestrator);
    expect(removed).toBe(true);

    // Verify removed
    expect(listProjects(dirs.orchestrator)).not.toContain("test-project");
  });

  it("removeProject returns false for unknown project", () => {
    const dirs = createTestDirs("add-remove-unknown");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);

    const removed = removeProject("nonexistent", dirs.orchestrator);
    expect(removed).toBe(false);
  });

  it("multiple projects can be added", () => {
    const dirs = createTestDirs("add-multiple");
    allDirs.push(dirs);

    // Create additional project directories
    const project2 = join(dirs.base, "project2");
    mkdirSync(project2, { recursive: true });
    execSync("git init", { cwd: project2, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: project2, stdio: "pipe" });
    execSync('git config user.name "Test User"', { cwd: project2, stdio: "pipe" });

    initializeWhs(dirs.orchestrator);

    addProject("project-a", dirs.project, {}, dirs.orchestrator);
    addProject("project-b", project2, {}, dirs.orchestrator);

    const projects = listProjects(dirs.orchestrator);
    expect(projects).toHaveLength(2);
    expect(projects).toContain("project-a");
    expect(projects).toContain("project-b");
  });

  it("stores correct default options", () => {
    const dirs = createTestDirs("add-defaults");
    allDirs.push(dirs);

    initializeWhs(dirs.orchestrator);
    addProject("test-project", dirs.project, {}, dirs.orchestrator);

    const project = getProject("test-project", dirs.orchestrator);

    expect(project!.baseBranch).toBe("main");
    expect(project!.agentsPath).toBe("docs/llm/agents");
    expect(project!.beadsMode).toBe("committed");
  });
});
