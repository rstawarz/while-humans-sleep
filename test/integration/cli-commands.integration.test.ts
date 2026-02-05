/**
 * Integration tests for CLI commands
 *
 * Tests the CLI command functionality by calling the underlying
 * functions directly (since we can't easily test the actual CLI process).
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import {
  initializeWhs,
  addProject,
  loadConfig,
  expandPath,
} from "../../src/config.js";
import { beads } from "../../src/beads/index.js";
import {
  startWorkflow,
  markStepInProgress,
} from "../../src/workflow.js";
import type { QuestionBeadData, WorkItem } from "../../src/types.js";

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

describe("CLI commands", () => {
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

  describe("whs questions", () => {
    it("lists pending questions", async () => {
      const dirs = createTestDirs("cli-questions-list");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const sourceBead = beads.create("Test task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(sourceBead, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Create a question bead
      const questionData: QuestionBeadData = {
        metadata: {
          session_id: "test-session-123",
          worktree: "/path/to/worktree",
          step_id: stepId,
          epic_id: epicId,
          project: "test-project",
          asked_at: new Date().toISOString(),
        },
        context: "Need to decide on auth approach",
        questions: [
          {
            question: "Should we use JWT or sessions?",
            header: "Auth method",
            options: [
              { label: "JWT", description: "Stateless tokens" },
              { label: "Sessions", description: "Server-side sessions" },
            ],
            multiSelect: false,
          },
        ],
      };

      beads.createQuestion(
        "Question: Auth method choice",
        dirs.orchestrator,
        questionData,
        epicId,
        stepId
      );

      // List pending questions (simulating `whs questions` command)
      const pendingQuestions = beads.listPendingQuestions(dirs.orchestrator);

      expect(pendingQuestions.length).toBe(1);
      expect(pendingQuestions[0].labels).toContain("whs:question");
      expect(pendingQuestions[0].status).toBe("open");

      // Parse the question data
      const parsedData = beads.parseQuestionData(pendingQuestions[0]);
      expect(parsedData.metadata.session_id).toBe("test-session-123");
      expect(parsedData.questions[0].question).toBe("Should we use JWT or sessions?");
    });

    it("returns empty list when no questions", () => {
      const dirs = createTestDirs("cli-questions-empty");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });

      const pendingQuestions = beads.listPendingQuestions(dirs.orchestrator);
      expect(pendingQuestions).toHaveLength(0);
    });
  });

  describe("whs answer", () => {
    it("closes question bead when answered", async () => {
      const dirs = createTestDirs("cli-answer-close");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const sourceBead = beads.create("Test task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(sourceBead, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      const questionData: QuestionBeadData = {
        metadata: {
          session_id: "test-session-456",
          worktree: "/path/to/worktree",
          step_id: stepId,
          epic_id: epicId,
          project: "test-project",
          asked_at: new Date().toISOString(),
        },
        context: "Need input",
        questions: [
          { question: "JWT or Sessions?", header: "Auth", options: [], multiSelect: false },
        ],
      };

      const questionBead = beads.createQuestion(
        "Question: Auth choice",
        dirs.orchestrator,
        questionData,
        epicId,
        stepId
      );

      // Answer the question (simulating part of `whs answer` command)
      // Note: The full command also resumes the agent session, which we can't do here
      beads.answerQuestion(questionBead.id, "Use JWT", dirs.orchestrator);

      // Verify question is closed
      const closedQuestion = beads.show(questionBead.id, dirs.orchestrator);
      expect(closedQuestion.status).toBe("closed");

      // No more pending questions
      const pendingQuestions = beads.listPendingQuestions(dirs.orchestrator);
      expect(pendingQuestions).toHaveLength(0);
    });

    it("handles partial ID match", async () => {
      const dirs = createTestDirs("cli-answer-partial");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const sourceBead = beads.create("Test task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(sourceBead, "test-project");
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
        questions: [
          { question: "Q?", header: "H", options: [], multiSelect: false },
        ],
      };

      const questionBead = beads.createQuestion(
        "Question: Test",
        dirs.orchestrator,
        questionData,
        epicId,
        stepId
      );

      // Get the full question ID (e.g., "orc-1.1")
      const fullId = questionBead.id;

      // Simulate partial ID matching (like the CLI does)
      const pendingQuestions = beads.listPendingQuestions(dirs.orchestrator);

      // Use last part of ID for partial match
      const partialId = fullId.split("-").pop() || fullId;
      const matches = pendingQuestions.filter((b) => b.id.includes(partialId));

      expect(matches.length).toBe(1);
      expect(matches[0].id).toBe(fullId);

      // Answer using the full ID from the match
      beads.answerQuestion(matches[0].id, "Answer", dirs.orchestrator);

      // Verify closed
      const closedQuestion = beads.show(fullId, dirs.orchestrator);
      expect(closedQuestion.status).toBe("closed");
    });

    it("errors on unknown question ID", () => {
      const dirs = createTestDirs("cli-answer-unknown");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });

      const pendingQuestions = beads.listPendingQuestions(dirs.orchestrator);

      // Simulate CLI behavior: check if question exists
      const unknownId = "nonexistent-id-12345";
      const matches = pendingQuestions.filter((b) => b.id.includes(unknownId) || b.id === unknownId);

      expect(matches.length).toBe(0);

      // The CLI would show an error at this point
      // We verify the detection mechanism works
    });

    it("errors on ambiguous partial ID match", async () => {
      const dirs = createTestDirs("cli-answer-ambiguous");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const sourceBead = beads.create("Test task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(sourceBead, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Create two questions
      const questionData1: QuestionBeadData = {
        metadata: {
          session_id: "session-1",
          worktree: "/path/to/worktree",
          step_id: stepId,
          epic_id: epicId,
          project: "test-project",
          asked_at: new Date().toISOString(),
        },
        context: "First question",
        questions: [
          { question: "Q1?", header: "H", options: [], multiSelect: false },
        ],
      };

      const questionData2: QuestionBeadData = {
        metadata: {
          session_id: "session-2",
          worktree: "/path/to/worktree",
          step_id: stepId,
          epic_id: epicId,
          project: "test-project",
          asked_at: new Date().toISOString(),
        },
        context: "Second question",
        questions: [
          { question: "Q2?", header: "H", options: [], multiSelect: false },
        ],
      };

      beads.createQuestion("Question: First", dirs.orchestrator, questionData1, epicId, stepId);
      beads.createQuestion("Question: Second", dirs.orchestrator, questionData2, epicId, stepId);

      // Get all pending questions
      const pendingQuestions = beads.listPendingQuestions(dirs.orchestrator);
      expect(pendingQuestions.length).toBe(2);

      // Try to match with a very generic partial ID that might match both
      // Questions typically have sequential IDs like "orc-1.1", "orc-1.2"
      // Let's match on common prefix
      const commonPrefix = "orc";
      const ambiguousMatches = pendingQuestions.filter((b) => b.id.includes(commonPrefix));

      // Both questions should match
      expect(ambiguousMatches.length).toBe(2);

      // The CLI would show an error about multiple matches at this point
    });
  });

  describe("whs status", () => {
    it("shows correct state with no active work", () => {
      const dirs = createTestDirs("cli-status-empty");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });

      // Load config (simulating what status command does)
      process.chdir(dirs.orchestrator);
      const config = loadConfig(dirs.orchestrator);

      expect(config).toBeDefined();
      expect(config.projects).toEqual([]);
      expect(config.concurrency.maxTotal).toBe(4);

      // Check pending questions
      const pendingQuestions = beads.listPendingQuestions(dirs.orchestrator);
      expect(pendingQuestions).toHaveLength(0);
    });

    it("shows pending question count", async () => {
      const dirs = createTestDirs("cli-status-questions");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const sourceBead = beads.create("Test task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(sourceBead, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Create multiple questions
      for (let i = 0; i < 3; i++) {
        const questionData: QuestionBeadData = {
          metadata: {
            session_id: `session-${i}`,
            worktree: "/path/to/worktree",
            step_id: stepId,
            epic_id: epicId,
            project: "test-project",
            asked_at: new Date().toISOString(),
          },
          context: `Question ${i}`,
          questions: [
            { question: `Q${i}?`, header: "H", options: [], multiSelect: false },
          ],
        };

        beads.createQuestion(`Question: Test ${i}`, dirs.orchestrator, questionData, epicId, stepId);
      }

      // Check status (simulating what status command does)
      const orchestratorPath = expandPath(loadConfig(dirs.orchestrator).orchestratorPath);
      const pendingQuestions = beads.listPendingQuestions(orchestratorPath);

      expect(pendingQuestions.length).toBe(3);
    });

    it("shows project list", () => {
      const dirs = createTestDirs("cli-status-projects");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });

      // Add multiple projects
      addProject("project-alpha", dirs.project, { baseBranch: "main" }, dirs.orchestrator);

      // Create another project dir for variety
      const project2 = join(dirs.base, "project2");
      mkdirSync(project2, { recursive: true });
      execSync("git init", { cwd: project2, stdio: "pipe" });
      execSync('git config user.email "test@test.com"', { cwd: project2, stdio: "pipe" });
      execSync('git config user.name "Test User"', { cwd: project2, stdio: "pipe" });
      beads.init(project2, { prefix: "proj2" });
      addProject("project-beta", project2, { baseBranch: "develop" }, dirs.orchestrator);

      // Load config and verify projects
      process.chdir(dirs.orchestrator);
      const config = loadConfig(dirs.orchestrator);

      expect(config.projects.length).toBe(2);
      expect(config.projects.map((p) => p.name)).toContain("project-alpha");
      expect(config.projects.map((p) => p.name)).toContain("project-beta");

      // Cleanup additional project
      try {
        beads.daemonStop(project2);
      } catch {
        // Ignore
      }
    });
  });

  describe("whs plan", () => {
    it("creates epic and planning task without dependency cycle", () => {
      const dirs = createTestDirs("cli-plan-basic");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      process.chdir(dirs.orchestrator);

      const description = "Add user authentication";
      const priority = 2;

      // Simulate what `whs plan` does:

      // 1. Create epic in project beads (blocked status)
      const epic = beads.create(description, dirs.project, {
        type: "epic",
        status: "blocked",
        priority,
        description: `Epic for: ${description}\n\nCreated via whs plan.`,
        labels: ["whs", "needs-planning"],
      });

      expect(epic.type).toBe("epic");
      expect(epic.status).toBe("blocked");

      // 2. Create planning task with label (NOT parent) to avoid cycle
      const planningTask = beads.create(`Plan: ${description}`, dirs.project, {
        type: "task",
        status: "open",
        priority,
        description: `Planning task for: ${description}`,
        labels: ["whs", "planning", "agent:planner", `epic:${epic.id}`],
      });

      expect(planningTask.type).toBe("task");
      expect(planningTask.status).toBe("open");
      expect(planningTask.labels).toContain(`epic:${epic.id}`);

      // 3. Add dependency: epic is blocked by planning task
      // This should NOT throw a cycle error
      expect(() => {
        beads.depAdd(epic.id, planningTask.id, dirs.project);
      }).not.toThrow();

      // 4. Verify the dependency was added
      const updatedEpic = beads.show(epic.id, dirs.project);
      const hasDep = updatedEpic.dependencies.some((d: string | { id: string; depends_on_id?: string }) =>
        typeof d === "string" ? d === planningTask.id : (d.depends_on_id === planningTask.id || d.id === planningTask.id)
      );
      expect(hasDep).toBe(true);

      // 5. Planning task should be ready (no dependencies)
      const readyBeads = beads.ready(dirs.project);
      expect(readyBeads.map((b) => b.id)).toContain(planningTask.id);

      // 6. Epic should NOT be ready (blocked status and has dependency)
      expect(readyBeads.map((b) => b.id)).not.toContain(epic.id);
    });

    it("planning task with parent relationship causes cycle error", () => {
      const dirs = createTestDirs("cli-plan-cycle");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      process.chdir(dirs.orchestrator);

      // Create epic
      const epic = beads.create("Feature with parent bug", dirs.project, {
        type: "epic",
        status: "blocked",
        labels: ["whs"],
      });

      // Create planning task WITH parent (the bug pattern)
      const planningTask = beads.create("Plan: Feature", dirs.project, {
        type: "task",
        status: "open",
        parent: epic.id, // This is the bug!
        labels: ["whs", "planning"],
      });

      // Trying to add dependency should throw cycle error
      expect(() => {
        beads.depAdd(epic.id, planningTask.id, dirs.project);
      }).toThrow(/cycle/i);
    });

    it("planning workflow completes correctly", () => {
      const dirs = createTestDirs("cli-plan-complete");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      process.chdir(dirs.orchestrator);

      // Create the planning workflow (correct pattern)
      const epic = beads.create("Feature to plan", dirs.project, {
        type: "epic",
        status: "blocked",
        labels: ["whs", "needs-planning"],
      });

      const planningTask = beads.create("Plan: Feature", dirs.project, {
        type: "task",
        status: "open",
        labels: ["whs", "planning", "agent:planner", `epic:${epic.id}`],
      });

      beads.depAdd(epic.id, planningTask.id, dirs.project);

      // Simulate planner completing: close planning task
      beads.close(planningTask.id, "Planning complete", dirs.project);

      // Update epic to open status
      beads.update(epic.id, dirs.project, { status: "open" });

      // Now epic should be ready (dependency closed, status open)
      const readyBeads = beads.ready(dirs.project);
      expect(readyBeads.map((b) => b.id)).toContain(epic.id);
    });
  });

  describe("step status management", () => {
    it("markStepInProgress updates step status", async () => {
      const dirs = createTestDirs("cli-step-inprogress");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const sourceBead = beads.create("Test task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(sourceBead, "test-project");
      const { stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Initially the step should be open
      let step = beads.show(stepId, dirs.orchestrator);
      expect(step.status).toBe("open");

      // Mark as in_progress (this is what the answer command does before resuming)
      markStepInProgress(stepId);

      // Verify status changed
      step = beads.show(stepId, dirs.orchestrator);
      expect(step.status).toBe("in_progress");
    });
  });
});
