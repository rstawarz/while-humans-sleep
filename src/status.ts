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
import { getErroredWorkflows, type ErroredWorkflow } from "./workflow.js";
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

export interface StepDetailData {
  work: ActiveWorkInfo;
  recentActivity: AgentLogEvent[];
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
 *
 * Returns null if the step is not found in active work.
 */
export function getStepDetail(stepQuery: string): StepDetailData | null {
  const status = getStatusData();

  // Find matching active work
  const match = status.activeWork.find((w) => {
    return w.source === stepQuery || w.stepId === stepQuery || w.source.endsWith("/" + stepQuery);
  });

  if (!match) return null;

  // Read recent activity from the agent log
  const recentActivity = readAgentLog(match.stepId, 20);

  return { work: match, recentActivity };
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
