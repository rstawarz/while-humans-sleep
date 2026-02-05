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
import { initializeWhs, loadConfig, addProject } from "../../../src/config.js";
import { Dispatcher } from "../../../src/dispatcher.js";
import type {
  Config,
  Notifier,
  QuestionBeadData,
  ActiveWork,
} from "../../../src/types.js";

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

/**
 * Notification event types for MockNotifier
 */
export interface QuestionNotification {
  questionBeadId: string;
  data: QuestionBeadData;
}

export interface ProgressNotification {
  work: ActiveWork;
  message: string;
}

export interface CompleteNotification {
  work: ActiveWork;
  result: "done" | "blocked";
}

export interface ErrorNotification {
  work: ActiveWork;
  error: Error;
}

/**
 * Mock Notifier that captures all notifications for testing
 */
export class MockNotifier implements Notifier {
  questions: QuestionNotification[] = [];
  progressUpdates: ProgressNotification[] = [];
  completions: CompleteNotification[] = [];
  errors: ErrorNotification[] = [];
  rateLimitErrors: Error[] = [];

  async notifyQuestion(questionBeadId: string, data: QuestionBeadData): Promise<void> {
    this.questions.push({ questionBeadId, data });
  }

  async notifyProgress(work: ActiveWork, message: string): Promise<void> {
    this.progressUpdates.push({ work, message });
  }

  async notifyComplete(work: ActiveWork, result: "done" | "blocked"): Promise<void> {
    this.completions.push({ work, result });
  }

  async notifyError(work: ActiveWork, error: Error): Promise<void> {
    this.errors.push({ work, error });
  }

  async notifyRateLimit(error: Error): Promise<void> {
    this.rateLimitErrors.push(error);
  }

  /**
   * Resets all captured notifications
   */
  reset(): void {
    this.questions = [];
    this.progressUpdates = [];
    this.completions = [];
    this.errors = [];
    this.rateLimitErrors = [];
  }

  /**
   * Gets the last question notification
   */
  getLastQuestion(): QuestionNotification | undefined {
    return this.questions[this.questions.length - 1];
  }

  /**
   * Gets the last completion notification
   */
  getLastCompletion(): CompleteNotification | undefined {
    return this.completions[this.completions.length - 1];
  }
}

/**
 * Extended test environment with dispatcher support
 */
export interface DispatcherTestEnvironment extends TestEnvironment {
  /** Pre-configured dispatcher instance */
  dispatcher: Dispatcher;
  /** Mock notifier for capturing events */
  notifier: MockNotifier;
}

/**
 * Options for creating a dispatcher test environment
 */
export interface DispatcherTestEnvironmentOptions extends TestEnvironmentOptions {
  /** Project name to add (defaults to "test-project") */
  projectName?: string;
  /** Base branch for the project (defaults to "main") */
  baseBranch?: string;
  /** Max concurrent total (defaults to 4) */
  maxConcurrentTotal?: number;
  /** Max concurrent per project (defaults to 2) */
  maxConcurrentPerProject?: number;
}

/**
 * Creates a test environment with a pre-configured dispatcher
 *
 * This sets up:
 * - Orchestrator with beads initialized
 * - Project with beads initialized
 * - Project added to config
 * - Dispatcher instance with MockNotifier
 */
export async function createDispatcherTestEnvironment(
  testName: string,
  options: DispatcherTestEnvironmentOptions = {}
): Promise<DispatcherTestEnvironment> {
  const {
    projectName = "test-project",
    baseBranch = "main",
    maxConcurrentTotal = 4,
    maxConcurrentPerProject = 2,
    ...baseOptions
  } = options;

  // Create base test environment
  const env = await createTestEnvironment(testName, {
    initBeads: true,
    initProjectBeads: true,
    ...baseOptions,
  });

  // Add project to config
  addProject(projectName, env.projectPath, {
    baseBranch,
  }, env.orchestratorPath);

  // Create a git branch matching baseBranch in the project
  try {
    execSync(`git checkout -b ${baseBranch}`, { cwd: env.projectPath, stdio: "pipe" });
  } catch {
    // Branch might already exist
    try {
      execSync(`git checkout ${baseBranch}`, { cwd: env.projectPath, stdio: "pipe" });
    } catch {
      // Ignore
    }
  }

  // Load config and create dispatcher
  const config = loadConfig(env.orchestratorPath);

  // Override concurrency settings for tests
  config.concurrency.maxTotal = maxConcurrentTotal;
  config.concurrency.maxPerProject = maxConcurrentPerProject;

  const notifier = new MockNotifier();
  const dispatcher = new Dispatcher(config, notifier);

  // Create extended cleanup
  const baseCleanup = env.cleanup;
  const cleanup = async (): Promise<void> => {
    // Stop dispatcher if running
    try {
      await dispatcher.stop();
    } catch {
      // Ignore
    }
    // Call base cleanup
    await baseCleanup();
  };

  return {
    ...env,
    config,
    dispatcher,
    notifier,
    cleanup,
  };
}

/**
 * Creates a workflow step bead for testing
 */
export function createWorkflowStep(
  env: TestEnvironment,
  epicId: string,
  agent: string,
  options: {
    description?: string;
    status?: "open" | "in_progress" | "closed";
    labels?: string[];
  } = {}
): string {
  const bead = beads.create(agent, env.orchestratorPath, {
    type: "task",
    parent: epicId,
    description: options.description,
    labels: [`agent:${agent}`, ...(options.labels || [])],
  });

  if (options.status && options.status !== "open") {
    beads.update(bead.id, env.orchestratorPath, { status: options.status });
  }

  return bead.id;
}

/**
 * Creates a workflow epic bead for testing
 */
export function createWorkflowEpic(
  env: TestEnvironment,
  project: string,
  sourceBeadId: string,
  title: string,
  options: {
    description?: string;
    status?: "open" | "in_progress" | "blocked" | "closed";
    labels?: string[];
  } = {}
): string {
  const bead = beads.create(`${project}:${sourceBeadId} - ${title}`, env.orchestratorPath, {
    type: "epic",
    description: options.description || `Source: ${project}/${sourceBeadId}`,
    labels: [`project:${project}`, `source:${sourceBeadId}`, ...(options.labels || [])],
  });

  if (options.status && options.status !== "open") {
    beads.update(bead.id, env.orchestratorPath, { status: options.status });
  }

  return bead.id;
}

/**
 * Checks if worktrunk (wt) CLI is installed
 */
export function isWorktrunkInstalled(): boolean {
  try {
    execSync("wt --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
