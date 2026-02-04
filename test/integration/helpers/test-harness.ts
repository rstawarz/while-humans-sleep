/**
 * Test Harness for WHS Integration Tests
 *
 * Sets up and tears down test environments with real beads CLI
 * but mocked Claude SDK.
 */

import { mkdirSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import { beads } from "../../../src/beads/index.js";
import { initializeWhs, loadConfig } from "../../../src/config.js";
import type { Config } from "../../../src/types.js";

/**
 * Test environment structure
 */
export interface TestEnvironment {
  /** The orchestrator directory (where .whs/ lives) */
  orchestratorPath: string;
  /** A fake project for testing */
  projectPath: string;
  /** Loaded config (call after init) */
  config?: Config;
  /** Cleanup function */
  cleanup: () => Promise<void>;
}

/**
 * Options for creating a test environment
 */
export interface TestEnvironmentOptions {
  /** Whether to initialize beads in orchestrator */
  initBeads?: boolean;
  /** Whether to initialize beads in project */
  initProjectBeads?: boolean;
  /** Beads prefix for orchestrator */
  orchestratorPrefix?: string;
  /** Beads prefix for project */
  projectPrefix?: string;
}

// Base path for test fixtures
const FIXTURES_BASE = resolve(__dirname, "../fixtures");

/**
 * Creates an isolated test environment with:
 * - A temporary orchestrator directory with .whs/ config
 * - A temporary project directory
 * - Git repos initialized in both
 * - Optionally beads initialized in both
 */
export async function createTestEnvironment(
  testName: string,
  options: TestEnvironmentOptions = {}
): Promise<TestEnvironment> {
  const {
    initBeads = true,
    initProjectBeads = true,
    orchestratorPrefix = "orc",
    projectPrefix = "proj",
  } = options;

  // Create unique directory name
  const timestamp = Date.now();
  const pid = process.pid;
  const dirName = `${testName}-${pid}-${timestamp}`;
  const basePath = join(FIXTURES_BASE, dirName);

  // Create directories
  const orchestratorPath = join(basePath, "orchestrator");
  const projectPath = join(basePath, "project");

  mkdirSync(orchestratorPath, { recursive: true });
  mkdirSync(projectPath, { recursive: true });

  // Initialize git in both directories
  execSync("git init", { cwd: orchestratorPath, stdio: "pipe" });
  execSync("git init", { cwd: projectPath, stdio: "pipe" });

  // Configure git user for commits (required for beads)
  const gitConfig = [
    'git config user.email "test@test.com"',
    'git config user.name "Test User"',
  ];
  for (const cmd of gitConfig) {
    execSync(cmd, { cwd: orchestratorPath, stdio: "pipe" });
    execSync(cmd, { cwd: projectPath, stdio: "pipe" });
  }

  // Initialize WHS config in orchestrator (creates .whs/config.json)
  initializeWhs(orchestratorPath);

  // Initialize beads if requested
  if (initBeads) {
    beads.init(orchestratorPath, { prefix: orchestratorPrefix });
  }

  if (initProjectBeads) {
    beads.init(projectPath, { prefix: projectPrefix });
  }

  const cleanup = async (): Promise<void> => {
    // Stop beads daemons
    try {
      beads.daemonStop(orchestratorPath);
    } catch {
      // Ignore
    }
    try {
      beads.daemonStop(projectPath);
    } catch {
      // Ignore
    }

    // Remove the test directory
    if (existsSync(basePath)) {
      rmSync(basePath, { recursive: true, force: true });
    }
  };

  return {
    orchestratorPath,
    projectPath,
    cleanup,
  };
}

/**
 * Loads config from a test environment's orchestrator
 */
export function loadTestConfig(env: TestEnvironment): Config {
  return loadConfig(env.orchestratorPath);
}

/**
 * Creates a task in the project beads
 */
export function createProjectTask(
  env: TestEnvironment,
  title: string,
  options: {
    type?: "task" | "epic" | "bug" | "feature";
    priority?: number;
    description?: string;
    labels?: string[];
  } = {}
): string {
  const bead = beads.create(title, env.projectPath, {
    type: options.type || "task",
    priority: options.priority,
    description: options.description,
    labels: options.labels,
  });
  return bead.id;
}

/**
 * Gets ready tasks from project beads
 */
export function getReadyTasks(env: TestEnvironment): string[] {
  const readyBeads = beads.ready(env.projectPath);
  return readyBeads.map((b) => b.id);
}

/**
 * Gets the beads list from a path
 */
export function getBeadsList(
  path: string,
  options?: { type?: string; status?: string }
): Array<{ id: string; title: string; status: string }> {
  const beadsList = beads.list(path, options as any);
  return beadsList.map((b) => ({
    id: b.id,
    title: b.title,
    status: b.status,
  }));
}

/**
 * Waits for a condition to be true with timeout
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timeout waiting for condition");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
