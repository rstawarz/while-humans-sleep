/**
 * Status Data — shared status gathering for CLI and Telegram
 *
 * Provides a single source of truth for dispatcher status information,
 * eliminating duplicate logic between `whs status` and `/status`.
 */

import { execSync } from "child_process";
import { loadState, getLockInfo } from "./state.js";
import { loadConfig, expandPath } from "./config.js";
import { beads } from "./beads/index.js";
import {
  getErroredWorkflows,
  getOrchestratorPath,
  type ErroredWorkflow,
} from "./workflow.js";
import { getTodayCost, getWorkflowSteps } from "./metrics.js";
import { readAgentLog, type AgentLogEvent } from "./agent-log.js";
import { VERSION } from "./version.js";
import type { ActiveWork, Config, QuestionBeadData } from "./types.js";
import type { Bead } from "./beads/types.js";

// === Types ===

export interface ActiveWorkInfo {
  title: string;
  source: string;       // "project/stepId"
  stepId: string;        // workflow step bead ID
  agent: string;
  stepNumber: number;
  durationMs: number;
  cost: number;
  prNumber: number | null;
  prUrl: string | null;
}

/** Info about a completed workflow step (from metrics DB) */
export interface WorkflowStepInfo {
  stepId: string;
  agent: string;
  outcome: string | null;
  durationMs: number;
  cost: number;
}

export interface StepDetailData {
  work: ActiveWorkInfo;
  recentActivity: AgentLogEvent[];
  /** Workflow step history (populated for bead-based lookups) */
  workflowSteps?: WorkflowStepInfo[];
  /** Workflow status (populated for bead-based lookups) */
  workflowStatus?: string;
}

export interface QuestionInfo {
  id: string;
  question: string;
  project: string;
}

export interface ErroredInfo {
  source: string;
  errorType: string;
}

export interface StatusData {
  version: string;
  running: boolean;
  paused: boolean;
  pid: number | null;
  uptimeMs: number;
  activeWork: ActiveWorkInfo[];
  questions: QuestionInfo[];
  errored: ErroredInfo[];
  todayCost: number;
}

// === Public API ===

/**
 * Gathers all status data in one call.
 *
 * Both CLI and Telegram handlers should call this instead of
 * independently loading state, config, beads, etc.
 */
export function getStatusData(): StatusData {
  const lockInfo = getLockInfo();
  const state = loadState();

  const data: StatusData = {
    version: VERSION,
    running: !!lockInfo,
    paused: state.paused,
    pid: lockInfo?.pid ?? null,
    uptimeMs: lockInfo ? Date.now() - new Date(lockInfo.startedAt).getTime() : 0,
    activeWork: [],
    questions: [],
    errored: [],
    todayCost: 0,
  };

  // Active work
  if (state.activeWork.size > 0) {
    const config = loadConfig();
    const orchestratorPath = expandPath(config.orchestratorPath);

    for (const work of state.activeWork.values()) {
      data.activeWork.push(buildActiveWorkInfo(work, config, orchestratorPath));
    }
  }

  // Questions
  try {
    const config = loadConfig();
    const orchestratorPath = expandPath(config.orchestratorPath);
    const pendingQuestions = beads.listPendingQuestions(orchestratorPath);
    for (const q of pendingQuestions) {
      try {
        const qData = beads.parseQuestionData(q);
        data.questions.push({
          id: q.id,
          question: qData.questions?.[0]?.question || q.title,
          project: qData.metadata?.project || "",
        });
      } catch {
        data.questions.push({ id: q.id, question: q.title, project: "" });
      }
    }
  } catch {
    // Orchestrator may not be initialized
  }

  // Errored workflows
  try {
    const errored = getErroredWorkflows();
    for (const e of errored) {
      data.errored.push({
        source: `${e.sourceProject}/${e.sourceBeadId}`,
        errorType: e.errorType,
      });
    }
  } catch {
    // ignore
  }

  // Today's cost
  try {
    data.todayCost = getTodayCost();
  } catch {
    // ignore
  }

  return data;
}

/**
 * Gets detailed status for a specific step, including recent agent activity.
 *
 * The query can be:
 * - A step ID: "orc-yq0.2"
 * - A project/step: "bridget_ai/orc-yq0.2"
 * - A source bead: "bridget_ai/bai-zv0.4"
 * - A PR URL: "https://github.com/.../pull/46"
 * - A PR shorthand: "pr:46" or "#46"
 *
 * First checks active work (live data + agent logs), then falls back to
 * querying orchestrator beads for non-active workflows.
 */
export function getStepDetail(stepQuery: string): StepDetailData | null {
  const status = getStatusData();

  // First: check active work (has live data + agent logs)
  const match = status.activeWork.find((w) => {
    return w.source === stepQuery || w.stepId === stepQuery || w.source.endsWith("/" + stepQuery);
  });

  if (match) {
    const recentActivity = readAgentLog(match.stepId, 20);
    return { work: match, recentActivity };
  }

  // Fallback: query orchestrator beads
  return getBeadStepDetail(stepQuery);
}

/**
 * Queries orchestrator beads for step detail when the step isn't in activeWork.
 *
 * Handles multiple query formats:
 * - Step ID: "orc-zwx.3" → beads.show(id, orchestratorPath)
 * - Source bead: "bridget_ai/bai-zv0.4" → find epic with matching labels
 * - PR URL: "https://github.com/.../pull/46" → extract PR#, find step with pr: label
 * - PR shorthand: "pr:46" or "#46" → find step with pr: label
 */
function getBeadStepDetail(stepQuery: string): StepDetailData | null {
  try {
    const config = loadConfig();
    const orchestratorPath = getOrchestratorPath();

    // Parse query to determine resolution strategy
    const resolved = resolveStepQuery(stepQuery, orchestratorPath);
    if (!resolved) return null;

    const { stepBead, epicBead } = resolved;
    const { project, sourceId } = parseLabels(epicBead.labels);

    // Extract info from the step bead
    const agent = extractLabel(stepBead.labels, "agent:") || stepBead.title;
    const prNumber = extractPRNumber(stepBead.labels) ?? extractPRNumber(epicBead.labels);
    const ciLabel = extractLabel(stepBead.labels, "ci:");

    // Build PR URL
    let prUrl: string | null = null;
    if (prNumber !== null && project) {
      const projectConfig = config.projects.find((p) => p.name === project);
      if (projectConfig) {
        const repoUrl = getGitHubRepoUrl(expandPath(projectConfig.repoPath));
        if (repoUrl) {
          prUrl = `${repoUrl}/pull/${prNumber}`;
        }
      }
    }

    // Get step history from metrics
    const workflowSteps = buildWorkflowStepHistory(epicBead.id);

    // Determine step number
    const stepNumber = workflowSteps.length > 0
      ? workflowSteps.length + (stepBead.status === "open" || stepBead.status === "in_progress" ? 1 : 0)
      : 1;

    // Get cost from metrics (for completed steps)
    let cost = 0;
    const metricSteps = getWorkflowSteps(epicBead.id);
    const metricStep = metricSteps.find((s) => s.id === stepBead.id);
    if (metricStep) {
      cost = metricStep.cost || 0;
    }

    // Duration: use metrics if completed, otherwise from bead timestamps
    let durationMs = 0;
    if (metricStep?.started_at) {
      const start = new Date(metricStep.started_at).getTime();
      const end = metricStep.completed_at
        ? new Date(metricStep.completed_at).getTime()
        : Date.now();
      durationMs = end - start;
    } else if (stepBead.created_at) {
      const start = new Date(stepBead.created_at).getTime();
      const end = stepBead.updated_at
        ? new Date(stepBead.updated_at).getTime()
        : Date.now();
      durationMs = end - start;
    }

    // Build the title from the epic
    const epicTitle = epicBead.title.includes(" - ")
      ? epicBead.title.split(" - ").slice(1).join(" - ")
      : epicBead.title;

    // Determine workflow status
    let workflowStatus: string = epicBead.status;
    const errorLabel = epicBead.labels.find((l) => l.startsWith("errored:"));
    if (errorLabel) {
      workflowStatus = `errored (${errorLabel.replace("errored:", "")})`;
    }
    if (epicBead.labels.includes("blocked:human")) {
      workflowStatus = "blocked";
    }

    const work: ActiveWorkInfo = {
      title: epicTitle,
      source: `${project}/${sourceId}`,
      stepId: stepBead.id,
      agent,
      stepNumber,
      durationMs,
      cost,
      prNumber,
      prUrl,
    };

    return {
      work,
      recentActivity: [], // No live logs for non-active steps
      workflowSteps,
      workflowStatus,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a step query to a step bead and its parent epic
 */
function resolveStepQuery(
  query: string,
  orchestratorPath: string
): { stepBead: Bead; epicBead: Bead } | null {
  // 1. PR URL: https://github.com/.../pull/46
  const prUrlMatch = query.match(/\/pull\/(\d+)$/);
  if (prUrlMatch) {
    return resolveByPRNumber(parseInt(prUrlMatch[1], 10), orchestratorPath);
  }

  // 2. PR shorthand: "pr:46" or "#46"
  const prShortMatch = query.match(/^(?:pr:|#)(\d+)$/);
  if (prShortMatch) {
    return resolveByPRNumber(parseInt(prShortMatch[1], 10), orchestratorPath);
  }

  // 3. Source bead: "project/beadId" (contains /)
  if (query.includes("/")) {
    const [project, sourceBeadId] = query.split("/", 2);
    return resolveBySourceBead(project, sourceBeadId, orchestratorPath);
  }

  // 4. Direct step ID: "orc-zwx.3"
  return resolveByStepId(query, orchestratorPath);
}

/**
 * Resolves by direct step ID
 */
function resolveByStepId(
  stepId: string,
  orchestratorPath: string
): { stepBead: Bead; epicBead: Bead } | null {
  try {
    const stepBead = beads.show(stepId, orchestratorPath);
    if (!stepBead.parent) return null;
    const epicBead = beads.show(stepBead.parent, orchestratorPath);
    return { stepBead, epicBead };
  } catch {
    // Not a step ID — try as an epic ID (show latest step)
    try {
      const epicBead = beads.show(stepId, orchestratorPath);
      if (epicBead.type !== "epic") return null;
      return resolveLatestStep(epicBead, orchestratorPath);
    } catch {
      return null;
    }
  }
}

/**
 * Resolves by source bead (project/beadId)
 */
function resolveBySourceBead(
  project: string,
  sourceBeadId: string,
  orchestratorPath: string
): { stepBead: Bead; epicBead: Bead } | null {
  try {
    const epics = beads.list(orchestratorPath, {
      type: "epic",
      labelAll: [`source:${sourceBeadId}`, `project:${project}`],
    });
    if (epics.length === 0) return null;
    const epicBead = beads.show(epics[0].id, orchestratorPath);
    return resolveLatestStep(epicBead, orchestratorPath);
  } catch {
    return null;
  }
}

/**
 * Resolves by PR number — finds steps with pr:N label
 */
function resolveByPRNumber(
  prNumber: number,
  orchestratorPath: string
): { stepBead: Bead; epicBead: Bead } | null {
  try {
    // Fast path: find steps with pr:N label
    const steps = beads.list(orchestratorPath, {
      type: "task",
      labelAll: [`pr:${prNumber}`, "whs:step"],
    });

    if (steps.length > 0) {
      // Use the most recent step (last in list)
      const stepBead = beads.show(steps[steps.length - 1].id, orchestratorPath);
      if (!stepBead.parent) return null;
      const epicBead = beads.show(stepBead.parent, orchestratorPath);
      return { stepBead, epicBead };
    }

    // Fallback: look up PR branch name via gh, match to source bead
    try {
      const config = loadConfig();
      for (const project of config.projects) {
        const repoPath = expandPath(project.repoPath);
        try {
          const branchName = execSync(
            `gh pr view ${prNumber} --json headRefName --jq '.headRefName'`,
            { encoding: "utf-8", timeout: 10000, cwd: repoPath }
          ).trim();
          if (branchName) {
            const result = resolveBySourceBead(project.name, branchName, orchestratorPath);
            if (result) return result;
          }
        } catch {
          // PR not found in this repo, try next
        }
      }
    } catch {
      // gh fallback failed
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Finds the latest (most recent) step under an epic
 */
function resolveLatestStep(
  epicBead: Bead,
  orchestratorPath: string
): { stepBead: Bead; epicBead: Bead } | null {
  try {
    const steps = beads.list(orchestratorPath, {
      type: "task",
      parent: epicBead.id,
      labelAll: ["whs:step"],
    });

    if (steps.length === 0) return null;

    // Return the last step (most recently created)
    const stepBead = beads.show(steps[steps.length - 1].id, orchestratorPath);
    return { stepBead, epicBead };
  } catch {
    return null;
  }
}

/**
 * Builds step history for a workflow epic from metrics DB
 */
function buildWorkflowStepHistory(epicId: string): WorkflowStepInfo[] {
  try {
    const metricSteps = getWorkflowSteps(epicId);
    return metricSteps.map((step) => {
      const startMs = step.started_at ? new Date(step.started_at).getTime() : 0;
      const endMs = step.completed_at ? new Date(step.completed_at).getTime() : Date.now();
      return {
        stepId: step.id,
        agent: step.agent,
        outcome: step.outcome,
        durationMs: startMs > 0 ? endMs - startMs : 0,
        cost: step.cost || 0,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Extracts a label value by prefix (e.g., "agent:" → "implementation")
 */
function extractLabel(labels: string[], prefix: string): string | null {
  for (const label of labels) {
    if (label.startsWith(prefix)) {
      return label.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Parses project and sourceId from labels
 */
function parseLabels(labels: string[]): { project: string; sourceId: string } {
  let project = "";
  let sourceId = "";
  for (const label of labels) {
    if (label.startsWith("project:")) project = label.slice(8);
    if (label.startsWith("source:")) sourceId = label.slice(7);
  }
  return { project, sourceId };
}

// === Helpers ===

function buildActiveWorkInfo(
  work: ActiveWork,
  config: Config,
  orchestratorPath: string
): ActiveWorkInfo {
  const title = work.workItem.title || work.workItem.id;
  const source = `${work.workItem.project}/${work.workItem.id}`;
  const durationMs = Date.now() - new Date(work.startedAt).getTime();
  const cost = work.costSoFar || 0;

  // Step number from metrics
  let stepNumber = 1;
  try {
    const steps = getWorkflowSteps(work.workflowEpicId);
    const completedSteps = steps.filter((s) => s.completed_at !== null).length;
    stepNumber = completedSteps + 1;
  } catch {
    // ignore
  }

  // PR number from step bead labels
  let prNumber: number | null = null;
  try {
    const stepBead = beads.show(work.workflowStepId, orchestratorPath);
    prNumber = extractPRNumber(stepBead.labels);

    // If not on the step, check the epic labels too
    if (prNumber === null) {
      const epicBead = beads.show(work.workflowEpicId, orchestratorPath);
      prNumber = extractPRNumber(epicBead.labels);
    }
  } catch {
    // ignore
  }

  // PR URL from git remote
  let prUrl: string | null = null;
  if (prNumber !== null) {
    const project = config.projects.find((p) => p.name === work.workItem.project);
    if (project) {
      const repoUrl = getGitHubRepoUrl(expandPath(project.repoPath));
      if (repoUrl) {
        prUrl = `${repoUrl}/pull/${prNumber}`;
      }
    }
  }

  return { title, source, stepId: work.workflowStepId, agent: work.agent, stepNumber, durationMs, cost, prNumber, prUrl };
}

function extractPRNumber(labels: string[]): number | null {
  for (const label of labels) {
    if (label.startsWith("pr:")) {
      const num = parseInt(label.slice(3), 10);
      if (!isNaN(num)) return num;
    }
  }
  return null;
}

/** Cache GitHub repo URLs per project path to avoid repeated git calls */
const repoUrlCache = new Map<string, string | null>();

function getGitHubRepoUrl(projectPath: string): string | null {
  if (repoUrlCache.has(projectPath)) {
    return repoUrlCache.get(projectPath)!;
  }

  try {
    const remote = execSync("git remote get-url origin", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    // Convert SSH or HTTPS URLs to base HTTPS URL
    // git@github.com:Org/repo.git → https://github.com/Org/repo
    // https://github.com/Org/repo.git → https://github.com/Org/repo
    let url: string | null = null;
    const sshMatch = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) {
      url = `https://github.com/${sshMatch[1]}`;
    } else if (remote.startsWith("https://github.com/")) {
      url = remote.replace(/\.git$/, "");
    }

    repoUrlCache.set(projectPath, url);
    return url;
  } catch {
    repoUrlCache.set(projectPath, null);
    return null;
  }
}

// === Formatters ===

/**
 * Formats duration in milliseconds as human-readable string.
 * Returns "Xh Ym", "Ym", or "<1m".
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
