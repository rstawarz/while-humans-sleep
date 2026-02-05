/**
 * Integration tests for agent execution
 *
 * Tests agent execution using the mock agent, handoff parsing,
 * question handling, and session management.
 *
 * Note: These tests use mock agent responses, not real Claude API calls.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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
  createNextStep,
  completeStep,
  completeWorkflow,
  markStepInProgress,
  getReadyWorkflowSteps,
} from "../../src/workflow.js";
import { tryParseHandoff } from "../../src/handoff.js";
import type { WorkItem, QuestionBeadData, Handoff } from "../../src/types.js";
import {
  configureMockAgent,
  resetMockAgent,
  mockRunAgent,
  simpleResponse,
  questionResponse,
  agentResponse,
  workflowScript,
  getInvocationCount,
  getSessions,
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

describe("agent execution", () => {
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

  describe("handoff parsing", () => {
    it("parses handoff from agent YAML output", () => {
      const output = `
I've implemented the feature and created a PR.

\`\`\`yaml
next_agent: quality_review
pr_number: 47
ci_status: pending
context: |
  Implemented auth service with JWT tokens.
  Tests passing locally, ready for CI.
\`\`\`
`;

      const handoff = tryParseHandoff(output);

      expect(handoff).not.toBeNull();
      expect(handoff?.next_agent).toBe("quality_review");
      expect(handoff?.pr_number).toBe(47);
      expect(handoff?.ci_status).toBe("pending");
      expect(handoff?.context).toContain("JWT tokens");
    });

    it("parses handoff with DONE next_agent", () => {
      const output = `
All work completed successfully.

\`\`\`yaml
next_agent: DONE
context: Feature merged and deployed.
\`\`\`
`;

      const handoff = tryParseHandoff(output);

      expect(handoff).not.toBeNull();
      expect(handoff?.next_agent).toBe("DONE");
    });

    it("parses handoff with BLOCKED next_agent", () => {
      const output = `
Cannot proceed without additional information.

\`\`\`yaml
next_agent: BLOCKED
context: Need API credentials from infrastructure team.
\`\`\`
`;

      const handoff = tryParseHandoff(output);

      expect(handoff).not.toBeNull();
      expect(handoff?.next_agent).toBe("BLOCKED");
      expect(handoff?.context).toContain("API credentials");
    });

    it("returns null for invalid handoff", () => {
      const output = "Just some random text without a handoff.";

      const handoff = tryParseHandoff(output);

      expect(handoff).toBeNull();
    });

    it("parses handoff with minimal fields", () => {
      const output = `
\`\`\`yaml
next_agent: implementation
context: Needs more work.
\`\`\`
`;

      const handoff = tryParseHandoff(output);

      expect(handoff).not.toBeNull();
      expect(handoff?.next_agent).toBe("implementation");
      expect(handoff?.pr_number).toBeUndefined();
      expect(handoff?.ci_status).toBeUndefined();
    });
  });

  describe("mock agent responses", () => {
    it("returns configured handoff from mock agent", async () => {
      const expectedHandoff: Handoff = {
        next_agent: "quality_review",
        pr_number: 123,
        context: "Implemented feature X.",
      };

      configureMockAgent([
        simpleResponse(() => true, expectedHandoff),
      ]);

      const result = await mockRunAgent("Implement feature X", {
        cwd: "/tmp/test",
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("quality_review");

      // Parse handoff from output
      const handoff = tryParseHandoff(result.output);
      expect(handoff?.next_agent).toBe("quality_review");
      expect(handoff?.pr_number).toBe(123);
    });

    it("returns question from mock agent", async () => {
      configureMockAgent([
        questionResponse(
          () => true,
          [
            {
              question: "Which auth method should we use?",
              header: "Auth",
              options: [
                { label: "JWT", description: "Stateless tokens" },
                { label: "Sessions", description: "Server-side" },
              ],
              multiSelect: false,
            },
          ],
          "Need to decide on authentication approach"
        ),
      ]);

      const result = await mockRunAgent("Implement auth", { cwd: "/tmp/test" });

      expect(result.success).toBe(true);
      expect(result.pendingQuestion).toBeDefined();
      expect(result.pendingQuestion?.questions[0].question).toBe(
        "Which auth method should we use?"
      );
    });

    it("generates unique session IDs", async () => {
      configureMockAgent([
        simpleResponse(() => true, { next_agent: "DONE", context: "Done" }),
      ]);

      const result1 = await mockRunAgent("Task 1", { cwd: "/tmp/test" });
      const result2 = await mockRunAgent("Task 2", { cwd: "/tmp/test" });

      expect(result1.sessionId).not.toBe(result2.sessionId);
    });

    it("reuses session ID when resuming", async () => {
      configureMockAgent([
        questionResponse(
          () => true,
          [{ question: "Q?", header: "H", options: [], multiSelect: false }]
        ),
        simpleResponse(() => true, { next_agent: "DONE", context: "Done" }),
      ]);

      // First call - gets a question
      const result1 = await mockRunAgent("Start task", { cwd: "/tmp/test" });
      expect(result1.pendingQuestion).toBeDefined();
      const sessionId = result1.sessionId;

      // Second call - resumes with answer
      const result2 = await mockRunAgent("Use JWT", {
        cwd: "/tmp/test",
        resume: sessionId,
      });

      expect(result2.sessionId).toBe(sessionId);
    });
  });

  describe("workflow script helper", () => {
    it("executes multi-step workflow script", async () => {
      const scripts = workflowScript([
        {
          agent: "implementation",
          handoff: {
            next_agent: "quality_review",
            pr_number: 42,
            context: "PR created",
          },
        },
        {
          agent: "quality_review",
          handoff: {
            next_agent: "release_manager",
            pr_number: 42,
            ci_status: "passed",
            context: "PR approved",
          },
        },
        {
          agent: "release_manager",
          handoff: {
            next_agent: "DONE",
            context: "Merged",
          },
        },
      ]);

      configureMockAgent(scripts);

      // Run implementation agent
      const implResult = await mockRunAgent("implementation task", {
        cwd: "/tmp/test",
      });
      const implHandoff = tryParseHandoff(implResult.output);
      expect(implHandoff?.next_agent).toBe("quality_review");

      // Run quality_review agent
      const reviewResult = await mockRunAgent("quality_review task", {
        cwd: "/tmp/test",
      });
      const reviewHandoff = tryParseHandoff(reviewResult.output);
      expect(reviewHandoff?.next_agent).toBe("release_manager");

      // Run release_manager agent
      const releaseResult = await mockRunAgent("release_manager task", {
        cwd: "/tmp/test",
      });
      const releaseHandoff = tryParseHandoff(releaseResult.output);
      expect(releaseHandoff?.next_agent).toBe("DONE");
    });
  });

  describe("question bead creation", () => {
    it("creates question bead when agent asks question", async () => {
      const dirs = createTestDirs("agent-question-bead");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const sourceBead = beads.create("Test task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(sourceBead, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Configure mock to return a question
      configureMockAgent([
        questionResponse(
          () => true,
          [
            {
              question: "Which database should we use?",
              header: "Database",
              options: [
                { label: "PostgreSQL" },
                { label: "MySQL" },
              ],
              multiSelect: false,
            },
          ],
          "Need to choose database"
        ),
      ]);

      // Simulate running the agent and getting a question
      const result = await mockRunAgent("implementation task", {
        cwd: dirs.project,
      });

      expect(result.pendingQuestion).toBeDefined();

      // Create question bead (simulating what dispatcher does)
      const questionData: QuestionBeadData = {
        metadata: {
          session_id: result.sessionId,
          worktree: dirs.project,
          step_id: stepId,
          epic_id: epicId,
          project: "test-project",
          asked_at: new Date().toISOString(),
        },
        context: result.pendingQuestion!.context,
        questions: result.pendingQuestion!.questions,
      };

      const questionBead = beads.createQuestion(
        `Question: ${result.pendingQuestion!.questions[0].question}`,
        dirs.orchestrator,
        questionData,
        epicId,
        stepId
      );

      // Verify question bead was created
      expect(questionBead.status).toBe("open");
      expect(questionBead.labels).toContain("whs:question");

      // Verify it blocks the step
      const readySteps = getReadyWorkflowSteps();
      expect(readySteps.find((s) => s.id === stepId)).toBeUndefined();
    });
  });

  describe("session resumption", () => {
    it("resumes session after question answered", async () => {
      const dirs = createTestDirs("agent-resume");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const sourceBead = beads.create("Test task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(sourceBead, "test-project");
      const { epicId, stepId } = await startWorkflow("test-project", workItem, "implementation");

      // Track whether we've already returned the question
      let questionReturned = false;

      // First call returns a question, second call (with answer) returns completion
      configureMockAgent([
        // Return question on first call, completion on subsequent calls
        {
          match: () => {
            if (!questionReturned) {
              questionReturned = true;
              return true; // First call matches question
            }
            return false;
          },
          output: "I need some information.",
          question: {
            questions: [{ question: "Use JWT?", header: "Auth", options: [], multiSelect: false }],
            context: "Need auth decision",
          },
          costUsd: 0.01,
        },
        // This matches after question has been returned
        simpleResponse(
          () => questionReturned, // Match only after question was returned
          { next_agent: "quality_review", pr_number: 99, context: "Implemented with JWT" }
        ),
      ]);

      // Run agent - gets question
      const result1 = await mockRunAgent("implementation", { cwd: dirs.project });
      expect(result1.pendingQuestion).toBeDefined();

      // Create question bead
      const questionData: QuestionBeadData = {
        metadata: {
          session_id: result1.sessionId,
          worktree: dirs.project,
          step_id: stepId,
          epic_id: epicId,
          project: "test-project",
          asked_at: new Date().toISOString(),
        },
        context: result1.pendingQuestion!.context,
        questions: result1.pendingQuestion!.questions,
      };

      const questionBead = beads.createQuestion(
        "Question: Auth?",
        dirs.orchestrator,
        questionData,
        epicId,
        stepId
      );

      // Answer the question
      beads.answerQuestion(questionBead.id, "Yes, use JWT", dirs.orchestrator);

      // Mark step in progress before resuming
      markStepInProgress(stepId);

      // Resume with answer
      const result2 = await mockRunAgent("Yes, use JWT", {
        cwd: dirs.project,
        resume: result1.sessionId,
      });

      expect(result2.pendingQuestion).toBeUndefined();
      expect(result2.sessionId).toBe(result1.sessionId);

      // Parse handoff
      const handoff = tryParseHandoff(result2.output);
      expect(handoff?.next_agent).toBe("quality_review");
    });

    it("records session ID for later resumption", async () => {
      configureMockAgent([
        simpleResponse(() => true, { next_agent: "DONE", context: "Complete" }),
      ]);

      const result = await mockRunAgent("Task", { cwd: "/tmp/test" });

      expect(result.sessionId).toBeDefined();
      expect(result.sessionId).toMatch(/^mock-session-\d+$/);

      // Verify session is stored
      const sessions = getSessions();
      expect(sessions.has(result.sessionId)).toBe(true);
    });
  });

  describe("sequential agents", () => {
    it("handles full workflow through multiple agents", async () => {
      const dirs = createTestDirs("agent-sequential");
      allDirs.push(dirs);

      initializeWhs(dirs.orchestrator);
      beads.init(dirs.orchestrator, { prefix: "orc" });
      beads.init(dirs.project, { prefix: "proj" });
      addProject("test-project", dirs.project, {}, dirs.orchestrator);

      const sourceBead = beads.create("Full workflow task", dirs.project, { type: "task" });

      process.chdir(dirs.orchestrator);

      const workItem = createWorkItem(sourceBead, "test-project");
      const { epicId, stepId: implStepId } = await startWorkflow(
        "test-project",
        workItem,
        "implementation"
      );

      // Configure workflow responses
      configureMockAgent(
        workflowScript([
          {
            agent: "implementation",
            handoff: { next_agent: "quality_review", pr_number: 50, context: "PR created" },
          },
          {
            agent: "quality_review",
            handoff: {
              next_agent: "release_manager",
              pr_number: 50,
              ci_status: "passed",
              context: "Approved",
            },
          },
          {
            agent: "release_manager",
            handoff: { next_agent: "DONE", context: "Merged" },
          },
        ])
      );

      // Step 1: Implementation
      markStepInProgress(implStepId);
      const implResult = await mockRunAgent("implementation task", { cwd: dirs.project });
      const implHandoff = tryParseHandoff(implResult.output);
      expect(implHandoff?.next_agent).toBe("quality_review");

      completeStep(implStepId, implHandoff!.context);

      // Step 2: Quality Review
      const reviewStepId = createNextStep(epicId, "quality_review", implHandoff!.context, {
        pr_number: implHandoff?.pr_number,
      });
      markStepInProgress(reviewStepId);

      const reviewResult = await mockRunAgent("quality_review task", { cwd: dirs.project });
      const reviewHandoff = tryParseHandoff(reviewResult.output);
      expect(reviewHandoff?.next_agent).toBe("release_manager");

      completeStep(reviewStepId, reviewHandoff!.context);

      // Step 3: Release Manager
      const releaseStepId = createNextStep(epicId, "release_manager", reviewHandoff!.context, {
        pr_number: reviewHandoff?.pr_number,
        ci_status: reviewHandoff?.ci_status,
      });
      markStepInProgress(releaseStepId);

      const releaseResult = await mockRunAgent("release_manager task", { cwd: dirs.project });
      const releaseHandoff = tryParseHandoff(releaseResult.output);
      expect(releaseHandoff?.next_agent).toBe("DONE");

      completeStep(releaseStepId, releaseHandoff!.context);

      // Complete workflow
      completeWorkflow(epicId, "done", "Full workflow completed");

      // Verify final state
      const epic = beads.show(epicId, dirs.orchestrator);
      expect(epic.status).toBe("closed");

      // Verify we went through all 3 agents
      expect(getInvocationCount()).toBe(3);
    });
  });

  describe("agent-specific responses", () => {
    it("agentResponse helper matches agent name", async () => {
      configureMockAgent([
        agentResponse("implementation", {
          next_agent: "quality_review",
          context: "Impl done",
        }),
        agentResponse("quality_review", {
          next_agent: "DONE",
          context: "Review done",
        }),
      ]);

      // Implementation prompt should match implementation response
      const implResult = await mockRunAgent("Run implementation agent", { cwd: "/tmp/test" });
      const implHandoff = tryParseHandoff(implResult.output);
      expect(implHandoff?.next_agent).toBe("quality_review");

      // Quality review prompt should match quality_review response
      const reviewResult = await mockRunAgent("Run quality_review agent", { cwd: "/tmp/test" });
      const reviewHandoff = tryParseHandoff(reviewResult.output);
      expect(reviewHandoff?.next_agent).toBe("DONE");
    });
  });

  describe("error handling", () => {
    it("handles agent errors gracefully", async () => {
      configureMockAgent([
        {
          match: () => true,
          error: "Rate limit exceeded",
        },
      ]);

      const result = await mockRunAgent("Some task", { cwd: "/tmp/test" });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Rate limit exceeded");
    });
  });
});
