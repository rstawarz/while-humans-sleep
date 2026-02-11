/**
 * Workflow Orchestration
 *
 * Manages workflow epics and steps in the orchestrator beads repo.
 * Each source task from a project gets a workflow epic, with steps
 * representing individual agent runs.
 */

import { execSync } from "child_process";
import { beads } from "./beads/index.js";
import { loadConfig, expandPath, getProject } from "./config.js";
import type { WorkItem, Handoff } from "./types.js";
import type { Bead } from "./beads/types.js";

/**
 * Workflow epic representing a complete workflow for a source task
 */
export interface WorkflowEpic {
  id: string;
  sourceProject: string;
  sourceBeadId: string;
  title: string;
  status: "open" | "in_progress" | "blocked" | "closed";
  currentStepId?: string;
  createdAt: Date;
}

/**
 * Workflow step representing a single agent run
 */
export interface WorkflowStep {
  id: string;
  epicId: string;
  agent: string;
  context: string;
  status: "open" | "in_progress" | "closed";
  outcome?: string;
}

/**
 * Gets the orchestrator beads path from config
 */
export function getOrchestratorPath(): string {
  const config = loadConfig();
  return expandPath(config.orchestratorPath);
}

/**
 * Starts a new workflow for a source bead
 *
 * Creates a workflow epic in the orchestrator and the first step.
 * Returns the epic and first step IDs.
 */
export async function startWorkflow(
  project: string,
  sourceBead: WorkItem,
  firstAgent: string = "implementation"
): Promise<{ epicId: string; stepId: string }> {
  const orchestratorPath = getOrchestratorPath();

  // Mark source bead as in_progress to prevent duplicate workflows
  const projectConfig = getProject(project);
  if (projectConfig) {
    const projectPath = expandPath(projectConfig.repoPath);
    beads.update(sourceBead.id, projectPath, { status: "in_progress" });
  }

  // Create workflow epic
  const epicTitle = `${project}:${sourceBead.id} - ${sourceBead.title}`;
  const epicDescription = [
    `Source: ${project}/${sourceBead.id}`,
    `Priority: ${sourceBead.priority}`,
    `Type: ${sourceBead.type}`,
    "",
    "## Original Description",
    sourceBead.description,
  ].join("\n");

  const epic = beads.create(epicTitle, orchestratorPath, {
    type: "epic",
    priority: sourceBead.priority,
    labels: ["whs:workflow", `project:${project}`, `source:${sourceBead.id}`],
    description: epicDescription,
  });

  // Create first step under the epic
  const stepContext = [
    `Starting workflow for: ${sourceBead.title}`,
    "",
    sourceBead.description,
  ].join("\n");

  const step = beads.create(firstAgent, orchestratorPath, {
    type: "task",
    parent: epic.id,
    labels: [`agent:${firstAgent}`, "whs:step"],
    description: stepContext,
  });

  return {
    epicId: epic.id,
    stepId: step.id,
  };
}

/**
 * Creates the next step in a workflow
 *
 * Called after an agent completes and hands off to the next agent.
 */
export function createNextStep(
  epicId: string,
  agent: string,
  context: string,
  handoff?: Partial<Handoff>
): string {
  const orchestratorPath = getOrchestratorPath();

  // Build step description from context and handoff
  const descriptionLines = [context];

  if (handoff?.pr_number) {
    descriptionLines.push("", `PR: #${handoff.pr_number}`);
  }
  if (handoff?.ci_status) {
    descriptionLines.push(`CI Status: ${handoff.ci_status}`);
  }

  const labels = [`agent:${agent}`, "whs:step"];
  if (handoff?.pr_number) {
    labels.push(`pr:${handoff.pr_number}`);
  }
  if (handoff?.ci_status) {
    labels.push(`ci:${handoff.ci_status}`);
  }

  const step = beads.create(agent, orchestratorPath, {
    type: "task",
    parent: epicId,
    labels,
    description: descriptionLines.join("\n"),
  });

  return step.id;
}

/**
 * Marks a workflow step as complete
 */
export function completeStep(stepId: string, outcome: string): void {
  const orchestratorPath = getOrchestratorPath();
  beads.close(stepId, outcome, orchestratorPath);
}

/**
 * Marks a workflow as complete (DONE)
 *
 * Closes the workflow epic and optionally the source bead.
 */
export function completeWorkflow(
  epicId: string,
  result: "done" | "blocked",
  reason: string
): void {
  const orchestratorPath = getOrchestratorPath();

  if (result === "done") {
    beads.close(epicId, `Complete: ${reason}`, orchestratorPath);
  } else {
    // Mark as blocked instead of closing
    beads.update(epicId, orchestratorPath, {
      status: "blocked",
      labelAdd: ["blocked:human"],
    });
    beads.comment(epicId, `Blocked: ${reason}`, orchestratorPath);
  }
}

/**
 * Gets the context for a workflow step (for injecting into agent prompts)
 */
export function getWorkflowContext(stepId: string): string {
  const orchestratorPath = getOrchestratorPath();

  try {
    const step = beads.show(stepId, orchestratorPath);
    return step.description || "";
  } catch {
    return "";
  }
}

/**
 * Gets the workflow epic for a step
 */
export function getWorkflowEpic(stepId: string): Bead | null {
  const orchestratorPath = getOrchestratorPath();

  try {
    const step = beads.show(stepId, orchestratorPath);
    if (step.parent) {
      return beads.show(step.parent, orchestratorPath);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve parent epic ID for a bead.
 *
 * bd list/ready --json don't include the parent field, so we fall back
 * to bd show when it's missing. Consolidated here to avoid repeating
 * this workaround at every call site.
 */
function resolveParentEpic(bead: Bead, orchestratorPath: string): string {
  if (bead.parent) return bead.parent;
  try {
    const full = beads.show(bead.id, orchestratorPath);
    return full.parent || "";
  } catch {
    return "";
  }
}

/**
 * Gets ready workflow steps from the orchestrator
 *
 * Returns steps that are ready to be worked on (no blocking dependencies).
 * Only returns beads with the whs:step label (excludes questions and other bead types).
 * Filters out steps waiting for CI (ci:pending label).
 */
export function getReadyWorkflowSteps(): WorkflowStep[] {
  const orchestratorPath = getOrchestratorPath();

  try {
    const readyBeads = beads.ready(orchestratorPath, {
      type: "task",
      labelAll: ["whs:step"],
    });

    // Filter to only open steps that aren't waiting for CI
    // Steps paused for questions are reset to open and blocked by the question bead,
    // so they naturally reappear here once the question is answered and closed.
    return readyBeads
      .filter((bead) => bead.status === "open")
      .filter((bead) => !bead.labels.includes("ci:pending"))
      .map((bead) => {
        const epicId = resolveParentEpic(bead, orchestratorPath);
        return {
          id: bead.id,
          epicId,
          agent: extractAgentFromBead(bead),
          context: bead.description || "",
          status: bead.status as "open" | "in_progress" | "closed",
        };
      });
  } catch {
    return [];
  }
}

/**
 * Step pending CI check
 */
export interface PendingCIStep {
  id: string;
  epicId: string;
  prNumber: number;
  retryCount: number;
  agent: string;
  project: string;
}

/**
 * Gets workflow steps that are waiting for CI to complete
 *
 * Returns steps with ci:pending label and extracts PR number from pr:XXX label.
 */
export function getStepsPendingCI(): PendingCIStep[] {
  const orchestratorPath = getOrchestratorPath();

  try {
    const pendingBeads = beads.list(orchestratorPath, {
      type: "task",
      status: "open",
      labelAll: ["whs:step", "ci:pending"],
    });

    return pendingBeads
      .map((bead) => {
        const prNumber = extractPRNumber(bead.labels);
        const retryCount = extractCIRetryCount(bead.labels);
        if (prNumber === null) return null;
        const epicId = resolveParentEpic(bead, orchestratorPath);
        const sourceInfo = epicId ? getSourceBeadInfo(epicId) : null;
        const project = sourceInfo?.project || "";
        if (!project) return null;
        return {
          id: bead.id,
          epicId,
          prNumber,
          retryCount,
          agent: extractAgentFromBead(bead),
          project,
        };
      })
      .filter((step): step is PendingCIStep => step !== null);
  } catch {
    return [];
  }
}

/**
 * Extracts PR number from labels (pr:XXX)
 */
function extractPRNumber(labels: string[]): number | null {
  for (const label of labels) {
    if (label.startsWith("pr:")) {
      const num = parseInt(label.slice(3), 10);
      if (!isNaN(num)) return num;
    }
  }
  return null;
}

/**
 * Extracts CI retry count from labels (ci-retries:N)
 */
function extractCIRetryCount(labels: string[]): number {
  for (const label of labels) {
    if (label.startsWith("ci-retries:")) {
      const num = parseInt(label.slice(11), 10);
      if (!isNaN(num)) return num;
    }
  }
  return 0;
}

/**
 * Updates a step's CI status after checking
 *
 * Removes ci:pending, adds ci:passed or ci:failed.
 * If failed, increments ci-retries:N counter.
 */
export function updateStepCIStatus(
  stepId: string,
  status: "passed" | "failed",
  currentRetryCount: number
): void {
  const orchestratorPath = getOrchestratorPath();

  // Remove old CI labels
  const labelsToRemove = ["ci:pending", "ci:passed", "ci:failed"];
  // Also remove old retry count label
  for (let i = 0; i <= 10; i++) {
    labelsToRemove.push(`ci-retries:${i}`);
  }

  // Add new status label
  const labelsToAdd = [`ci:${status}`];

  // If failed, increment retry count
  if (status === "failed") {
    labelsToAdd.push(`ci-retries:${currentRetryCount + 1}`);
  }

  beads.update(stepId, orchestratorPath, {
    labelRemove: labelsToRemove,
    labelAdd: labelsToAdd,
  });
}

/**
 * Gets all active workflow epics
 */
export function getActiveWorkflows(): WorkflowEpic[] {
  const orchestratorPath = getOrchestratorPath();

  try {
    const epics = beads.list(orchestratorPath, {
      type: "epic",
      status: "open",
    });

    return epics.map((bead) => {
      const { project, sourceId } = parseEpicLabels(bead.labels || []);
      return {
        id: bead.id,
        sourceProject: project,
        sourceBeadId: sourceId,
        title: bead.title,
        status: bead.status as "open" | "in_progress" | "blocked" | "closed",
        createdAt: new Date(bead.created_at || Date.now()),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Gets workflow info for a source bead (if one exists)
 */
export function getWorkflowForSource(
  project: string,
  sourceBeadId: string
): WorkflowEpic | null {
  const orchestratorPath = getOrchestratorPath();

  try {
    const epics = beads.list(orchestratorPath, {
      type: "epic",
      labelAll: [`project:${project}`, `source:${sourceBeadId}`],
    });

    if (epics.length === 0) {
      return null;
    }

    const bead = epics[0];
    return {
      id: bead.id,
      sourceProject: project,
      sourceBeadId: sourceBeadId,
      title: bead.title,
      status: bead.status as "open" | "in_progress" | "blocked" | "closed",
      createdAt: new Date(bead.created_at || Date.now()),
    };
  } catch {
    return null;
  }
}

/**
 * Updates a workflow step's status to in_progress
 */
export function markStepInProgress(stepId: string): void {
  const orchestratorPath = getOrchestratorPath();
  beads.update(stepId, orchestratorPath, {
    status: "in_progress",
  });
}

/**
 * Resets a step to open (e.g., when paused for a question).
 * The step will be blocked by the question bead's dependency
 * and won't appear in bd ready until the question is answered.
 */
export function markStepOpen(stepId: string): void {
  const orchestratorPath = getOrchestratorPath();
  beads.update(stepId, orchestratorPath, {
    status: "open",
  });
}

/**
 * Resets a workflow step back to open for retry, with circuit breaker.
 *
 * Tracks dispatch attempts via a `dispatch-attempts:N` label.
 * After MAX_DISPATCH_ATTEMPTS failures, marks the workflow as BLOCKED
 * instead of resetting to open, preventing infinite retry loops.
 *
 * @returns true if step was reset to open, false if circuit breaker tripped
 */
export function resetStepForRetry(
  stepId: string,
  maxAttempts: number = 3
): boolean {
  const orchestratorPath = getOrchestratorPath();
  const attempts = getDispatchAttempts(stepId);

  if (attempts >= maxAttempts) {
    // Circuit breaker: mark the parent epic as blocked
    try {
      const step = beads.show(stepId, orchestratorPath);
      if (step.parent) {
        beads.update(step.parent, orchestratorPath, {
          status: "blocked",
          labelAdd: ["blocked:human"],
        });
        beads.comment(
          step.parent,
          `Blocked: Step ${stepId} failed to dispatch after ${attempts} attempts. Manual intervention required.`,
          orchestratorPath
        );
      }
      // Close the step as failed
      beads.close(
        stepId,
        `Failed to dispatch after ${attempts} attempts`,
        orchestratorPath
      );
    } catch {
      // Best effort
    }
    return false;
  }

  // Increment attempts and reset to open
  incrementDispatchAttempts(stepId, attempts);
  beads.update(stepId, orchestratorPath, {
    status: "open",
  });
  return true;
}

/**
 * Gets the number of dispatch attempts from step labels
 */
export function getDispatchAttempts(stepId: string): number {
  const orchestratorPath = getOrchestratorPath();

  try {
    const step = beads.show(stepId, orchestratorPath);
    for (const label of step.labels || []) {
      if (label.startsWith("dispatch-attempts:")) {
        const num = parseInt(label.slice(18), 10);
        if (!isNaN(num)) return num;
      }
    }
  } catch {
    // Step may not exist
  }
  return 0;
}

/**
 * Increments the dispatch attempts counter on a step
 */
function incrementDispatchAttempts(
  stepId: string,
  currentAttempts: number
): void {
  const orchestratorPath = getOrchestratorPath();

  // Remove old counter labels and add new one
  const labelsToRemove: string[] = [];
  for (let i = 0; i <= 10; i++) {
    labelsToRemove.push(`dispatch-attempts:${i}`);
  }

  beads.update(stepId, orchestratorPath, {
    labelRemove: labelsToRemove,
    labelAdd: [`dispatch-attempts:${currentAttempts + 1}`],
  });
}

/**
 * Adds a comment to a workflow step
 */
export function addStepComment(stepId: string, comment: string): void {
  const orchestratorPath = getOrchestratorPath();
  beads.comment(stepId, comment, orchestratorPath);
}

/**
 * Resume info stored on a step when a question has been answered
 */
export interface StepResumeInfo {
  sessionId: string;
  answer: string;
  worktree: string;
}

// Marker for resume info in step labels
const RESUME_LABEL_PREFIX = "whs:resume:";

/**
 * Stores resume info on a step (when a question is answered)
 *
 * The dispatcher will pick this up when the step becomes unblocked.
 * We use a label with base64-encoded JSON to store the data.
 */
export function setStepResumeInfo(
  stepId: string,
  info: StepResumeInfo
): void {
  const orchestratorPath = getOrchestratorPath();

  // Encode resume info as base64 JSON in a label
  const encoded = Buffer.from(JSON.stringify(info)).toString("base64");
  beads.update(stepId, orchestratorPath, {
    labelAdd: [`${RESUME_LABEL_PREFIX}${encoded}`],
  });
}

/**
 * Gets resume info from a step (if question was answered)
 *
 * Returns null if no resume info found.
 */
export function getStepResumeInfo(stepId: string): StepResumeInfo | null {
  const orchestratorPath = getOrchestratorPath();

  try {
    const step = beads.show(stepId, orchestratorPath);
    const resumeLabel = step.labels?.find((l) =>
      l.startsWith(RESUME_LABEL_PREFIX)
    );

    if (!resumeLabel) return null;

    const encoded = resumeLabel.slice(RESUME_LABEL_PREFIX.length);
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    return JSON.parse(decoded) as StepResumeInfo;
  } catch {
    return null;
  }
}

/**
 * Clears resume info from a step (after resuming)
 */
export function clearStepResumeInfo(stepId: string): void {
  const orchestratorPath = getOrchestratorPath();

  try {
    const step = beads.show(stepId, orchestratorPath);
    const resumeLabel = step.labels?.find((l) =>
      l.startsWith(RESUME_LABEL_PREFIX)
    );

    if (resumeLabel) {
      beads.update(stepId, orchestratorPath, {
        labelRemove: [resumeLabel],
      });
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Finds an orchestrator epic by source bead ID (without needing project name)
 *
 * Useful when the user passes a source bead ID (e.g., bai-zv0.1) instead
 * of an orchestrator epic ID (e.g., orc-abc).
 */
export function findEpicBySourceBead(sourceBeadId: string): WorkflowEpic | null {
  const orchestratorPath = getOrchestratorPath();

  try {
    const epics = beads.list(orchestratorPath, {
      type: "epic",
      labelAll: [`source:${sourceBeadId}`],
    });

    if (epics.length === 0) {
      return null;
    }

    const bead = epics[0];
    const { project, sourceId } = parseEpicLabels(bead.labels || []);
    return {
      id: bead.id,
      sourceProject: project,
      sourceBeadId: sourceId,
      title: bead.title,
      status: bead.status as "open" | "in_progress" | "blocked" | "closed",
      createdAt: new Date(bead.created_at || Date.now()),
    };
  } catch {
    return null;
  }
}

/**
 * Errored workflow info returned by getErroredWorkflows
 */
export interface ErroredWorkflow {
  epicId: string;
  errorType: string;
  reason: string;
  sourceProject: string;
  sourceBeadId: string;
}

/**
 * Marks a workflow as errored (distinguishable from legitimately blocked)
 *
 * Sets the epic to "blocked" status (beads has no "errored" status) and adds
 * an `errored:{errorType}` label. Does NOT touch the step — the step stays
 * in_progress, which keeps it out of the ready list (steps use `parent` not
 * `dep`, so beads.ready() doesn't check parent epic status).
 */
export function errorWorkflow(
  epicId: string,
  reason: string,
  errorType: string
): void {
  const orchestratorPath = getOrchestratorPath();

  beads.update(epicId, orchestratorPath, {
    status: "blocked",
    labelAdd: [`errored:${errorType}`],
  });
  beads.comment(epicId, `Errored (${errorType}): ${reason}`, orchestratorPath);
}

/**
 * Gets workflows that are in an errored state
 *
 * Returns epics with `errored:*` labels. These are workflows that failed
 * due to transient errors (auth, network) rather than being legitimately blocked.
 */
export function getErroredWorkflows(): ErroredWorkflow[] {
  const orchestratorPath = getOrchestratorPath();

  try {
    const epics = beads.list(orchestratorPath, {
      type: "epic",
      status: "blocked",
      labelAny: ["errored:auth"],
    });

    return epics.map((bead) => {
      const errorLabel = bead.labels?.find((l) => l.startsWith("errored:"));
      const errorType = errorLabel?.replace("errored:", "") || "unknown";
      const { project, sourceId } = parseEpicLabels(bead.labels || []);

      return {
        epicId: bead.id,
        errorType,
        reason: bead.description || "",
        sourceProject: project,
        sourceBeadId: sourceId,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Retries an errored or blocked workflow
 *
 * Resets the epic from "blocked" to "open", removes errored/blocked labels,
 * and resets any in_progress steps under the epic back to "open" so they
 * become visible to getReadyWorkflowSteps.
 */
export function retryWorkflow(epicId: string): void {
  const orchestratorPath = getOrchestratorPath();

  // Remove errored and blocked labels, reset status to open
  beads.update(epicId, orchestratorPath, {
    status: "open",
    labelRemove: ["blocked:human", "errored:auth"],
  });
  beads.comment(epicId, "Retrying workflow", orchestratorPath);

  // Get all steps via bd show (bd list --parent misses closed children)
  try {
    const raw = execSync(`bd show ${epicId} --json`, {
      cwd: orchestratorPath,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    const data = JSON.parse(raw) as Array<{
      dependents?: Array<{
        id: string;
        status: string;
        labels?: string[];
        title?: string;
      }>;
    }>;
    const steps = data[0]?.dependents ?? [];

    let hasOpenOrInProgress = false;
    for (const step of steps) {
      if (step.status === "in_progress") {
        beads.update(step.id, orchestratorPath, { status: "open" });
        hasOpenOrInProgress = true;
      } else if (step.status === "open") {
        hasOpenOrInProgress = true;
      }
    }

    // If all steps are closed, create a new step to resume from the last agent
    if (!hasOpenOrInProgress && steps.length > 0) {
      const lastStep = steps[steps.length - 1];
      const agentLabel = lastStep.labels?.find((l) => l.startsWith("agent:"));
      const agent = agentLabel?.replace("agent:", "") || "implementation";
      const description = `Retrying workflow — previous ${agent} step failed.`;
      createNextStep(epicId, agent, description);
    }
  } catch {
    // Best effort — steps may not exist
  }
}

/**
 * Extracts the agent name from a bead's labels or title
 */
function extractAgentFromBead(bead: Bead): string {
  // Try to find agent label
  const agentLabel = bead.labels?.find((l) => l.startsWith("agent:"));
  if (agentLabel) {
    return agentLabel.replace("agent:", "");
  }

  // Fall back to title (which should be the agent name for step beads)
  return bead.title;
}

/**
 * Parses project and source ID from epic labels
 */
function parseEpicLabels(labels: string[]): {
  project: string;
  sourceId: string;
} {
  let project = "";
  let sourceId = "";

  for (const label of labels) {
    if (label.startsWith("project:")) {
      project = label.replace("project:", "");
    } else if (label.startsWith("source:")) {
      sourceId = label.replace("source:", "");
    }
  }

  return { project, sourceId };
}

/**
 * Determines the first agent based on work item type and labels
 *
 * Planning tasks are identified by the "planning" label rather than type,
 * since beads doesn't have a native "planning" type.
 */
export function getFirstAgent(workItem: WorkItem): string {
  // Check for planning label first (takes precedence over type)
  if (workItem.labels?.includes("planning")) {
    return "planner";
  }

  switch (workItem.type) {
    case "bug":
      return "implementation";
    case "epic":
      return "planner";
    case "task":
    case "feature":
    case "chore":
    default:
      return "implementation";
  }
}

/**
 * Checks if a workflow epic has a specific label
 */
export function epicHasLabel(epicId: string, label: string): boolean {
  const orchestratorPath = getOrchestratorPath();

  try {
    const epic = beads.show(epicId, orchestratorPath);
    return epic.labels?.includes(label) ?? false;
  } catch {
    return false;
  }
}

/**
 * Adds a label to a workflow epic
 */
export function addEpicLabel(epicId: string, label: string): void {
  const orchestratorPath = getOrchestratorPath();
  beads.update(epicId, orchestratorPath, {
    labelAdd: [label],
  });
}

/**
 * Gets the source bead info from a workflow epic
 */
export function getSourceBeadInfo(epicId: string): {
  project: string;
  beadId: string;
} | null {
  const orchestratorPath = getOrchestratorPath();

  try {
    const epic = beads.show(epicId, orchestratorPath);
    const { project, sourceId } = parseEpicLabels(epic.labels || []);

    if (project && sourceId) {
      return { project, beadId: sourceId };
    }
    return null;
  } catch {
    return null;
  }
}
