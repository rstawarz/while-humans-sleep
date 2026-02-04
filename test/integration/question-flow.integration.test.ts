/**
 * Integration tests for question handling flow
 *
 * Tests creating question beads, blocking steps, and answering questions.
 * Uses real beads CLI.
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
import {
  startWorkflow,
  markStepInProgress,
  getReadyWorkflowSteps,
} from "../../src/workflow.js";
import type { QuestionBeadData } from "../../src/types.js";

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

describe("question handling flow", () => {
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

  it("createQuestion creates a question bead", async () => {
    const dirs = createTestDirs("question-create");
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

    // Create question data
    const questionData: QuestionBeadData = {
      metadata: {
        session_id: "test-session-123",
        worktree: "/path/to/worktree",
        step_id: stepId,
        epic_id: epicId,
        project: "test-project",
        asked_at: new Date().toISOString(),
      },
      context: "Need to decide on authentication approach",
      questions: [
        {
          question: "Which authentication method should we use?",
          header: "Auth method",
          options: [
            { label: "JWT", description: "JSON Web Tokens" },
            { label: "Sessions", description: "Server-side sessions" },
          ],
          multiSelect: false,
        },
      ],
    };

    // Create question bead
    const questionBead = beads.createQuestion(
      "Question: Which auth method?",
      dirs.orchestrator,
      questionData,
      epicId,
      stepId
    );

    // Verify question bead created
    // Questions are stored as tasks with "whs:question" label
    expect(questionBead.type).toBe("task");
    expect(questionBead.labels).toContain("whs:question");
    expect(questionBead.status).toBe("open");
    expect(questionBead.parent).toBe(epicId);

    // Verify data is stored in description
    const storedData = beads.parseQuestionData(questionBead);
    expect(storedData.metadata.session_id).toBe("test-session-123");
    expect(storedData.questions).toHaveLength(1);
    expect(storedData.questions[0].question).toBe("Which authentication method should we use?");
  });

  it("question bead blocks workflow step", async () => {
    const dirs = createTestDirs("question-blocks-step");
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

    // Mark step in progress
    markStepInProgress(stepId);

    // Step should not be in ready list when in_progress
    let readySteps = getReadyWorkflowSteps();
    expect(readySteps.find((s) => s.id === stepId)).toBeUndefined();

    // Now create a question bead that blocks the step
    const questionData: QuestionBeadData = {
      metadata: {
        session_id: "test-session",
        worktree: "/path/to/worktree",
        step_id: stepId,
        epic_id: epicId,
        project: "test-project",
        asked_at: new Date().toISOString(),
      },
      context: "Context",
      questions: [{ question: "Q?", header: "H", options: [], multiSelect: false }],
    };

    beads.createQuestion("Question", dirs.orchestrator, questionData, epicId, stepId);

    // Reset step to open to simulate dispatcher pausing work
    beads.update(stepId, dirs.orchestrator, { status: "open" });

    // Step should still be blocked because question bead is a dependency
    readySteps = getReadyWorkflowSteps();
    // The step should NOT appear in ready because question blocks it
    expect(readySteps.find((s) => s.id === stepId)).toBeUndefined();
  });

  it("listPendingQuestions returns open questions", async () => {
    const dirs = createTestDirs("question-list-pending");
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

    // Initially no questions
    let pending = beads.listPendingQuestions(dirs.orchestrator);
    expect(pending).toHaveLength(0);

    // Create question
    const questionData: QuestionBeadData = {
      metadata: {
        session_id: "test-session",
        worktree: "/path/to/worktree",
        step_id: stepId,
        epic_id: epicId,
        project: "test-project",
        asked_at: new Date().toISOString(),
      },
      context: "Need input",
      questions: [{ question: "What?", header: "Q", options: [], multiSelect: false }],
    };

    beads.createQuestion("Question", dirs.orchestrator, questionData, epicId, stepId);

    // Now should have one pending question
    pending = beads.listPendingQuestions(dirs.orchestrator);
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("task");
    expect(pending[0].labels).toContain("whs:question");
    expect(pending[0].status).toBe("open");
  });

  it("answerQuestion closes question and adds comment", async () => {
    const dirs = createTestDirs("question-answer");
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

    const questionData: QuestionBeadData = {
      metadata: {
        session_id: "test-session",
        worktree: "/path/to/worktree",
        step_id: stepId,
        epic_id: epicId,
        project: "test-project",
        asked_at: new Date().toISOString(),
      },
      context: "Need input",
      questions: [{ question: "JWT or Sessions?", header: "Auth", options: [], multiSelect: false }],
    };

    const questionBead = beads.createQuestion(
      "Question: Auth method",
      dirs.orchestrator,
      questionData,
      epicId,
      stepId
    );

    // Answer the question
    beads.answerQuestion(questionBead.id, "Use JWT", dirs.orchestrator);

    // Question should be closed
    const updatedQuestion = beads.show(questionBead.id, dirs.orchestrator);
    expect(updatedQuestion.status).toBe("closed");

    // No more pending questions
    const pending = beads.listPendingQuestions(dirs.orchestrator);
    expect(pending).toHaveLength(0);
  });

  it("answered question unblocks workflow step", async () => {
    const dirs = createTestDirs("question-unblock");
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

    // Create question that blocks step
    const questionData: QuestionBeadData = {
      metadata: {
        session_id: "test-session",
        worktree: "/path/to/worktree",
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

    // Step should be blocked (question is dependency)
    let readySteps = getReadyWorkflowSteps();
    expect(readySteps.find((s) => s.id === stepId)).toBeUndefined();

    // Answer the question (closes it)
    beads.answerQuestion(questionBead.id, "Answer", dirs.orchestrator);

    // Now step should be unblocked and appear in ready list
    readySteps = getReadyWorkflowSteps();
    const foundStep = readySteps.find((s) => s.id === stepId);
    expect(foundStep).toBeDefined();
  });
});
