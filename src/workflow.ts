/**
 * Workflow Orchestration
 *
 * Manages workflow epics and steps in the orchestrator beads repo.
 * Each source task from a project gets a workflow epic, with steps
 * representing individual agent runs.
 */

import { beads } from "./beads/index.js";
import { loadConfig, expandPath } from "./config.js";
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
    labels: [`project:${project}`, `source:${sourceBead.id}`],
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
 * Gets ready workflow steps from the orchestrator
 *
 * Returns steps that are ready to be worked on (no blocking dependencies).
 * Only returns beads with the whs:step label (excludes questions and other bead types).
 */
export function getReadyWorkflowSteps(): WorkflowStep[] {
  const orchestratorPath = getOrchestratorPath();

  try {
    const readyBeads = beads.ready(orchestratorPath, {
      type: "task",
      labelAll: ["whs:step"],
    });

    // Filter to only open steps - bd ready returns both open and in_progress
    // We only want steps that haven't been started yet
    return readyBeads
      .filter((bead) => bead.status === "open")
      .map((bead) => ({
        id: bead.id,
        epicId: bead.parent || "",
        agent: extractAgentFromBead(bead),
        context: bead.description || "",
        status: bead.status as "open" | "in_progress" | "closed",
      }));
  } catch {
    return [];
  }
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
 * Adds a comment to a workflow step
 */
export function addStepComment(stepId: string, comment: string): void {
  const orchestratorPath = getOrchestratorPath();
  beads.comment(stepId, comment, orchestratorPath);
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
