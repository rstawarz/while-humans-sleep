/**
 * Backlog Visualization
 *
 * Gathers project beads and overlays orchestrator workflow state
 * to produce a tree view of the project backlog.
 */

import { execSync } from "child_process";
import { beads } from "./beads/index.js";
import { loadConfig, expandPath, getProject } from "./config.js";
import { getWorkflowForSource, getOrchestratorPath } from "./workflow.js";
import type { Bead } from "./beads/types.js";

// === Types ===

export interface BacklogItem {
  bead: Bead;
  children: BacklogItem[];
  workflowStatus?: "active" | "blocked" | "errored" | "done";
  activeAgent?: string;
  activeStepNumber?: number;
  prNumber?: number | null;
  ciStatus?: string;
  hasQuestion?: boolean;
  blockedBy?: string[];
}

export interface BacklogSummary {
  open: number;
  inProgress: number;
  closed: number;
  blocked: number;
}

export interface BacklogData {
  project: string;
  items: BacklogItem[];
  summary: BacklogSummary;
}

// === Status Icons ===

const STATUS_ICONS: Record<string, string> = {
  closed: "✅",
  in_progress: "🔄",
  blocked: "🚫",
  open: "⏳",
  question: "❓",
  deferred: "⏳",
};

// === Public API ===

/**
 * Gather backlog data for a single project
 */
export function getBacklogData(
  projectName: string,
  options?: { includeAll?: boolean }
): BacklogData {
  const project = getProject(projectName);
  if (!project) {
    throw new Error(`Project "${projectName}" not found in config.`);
  }

  const projectPath = expandPath(project.repoPath);
  const includeAll = options?.includeAll ?? false;

  // Get all project beads (filter by status unless --all)
  let projectBeads: Bead[];
  if (includeAll) {
    projectBeads = beads.list(projectPath);
  } else {
    // Get non-closed beads: open, in_progress, blocked, deferred
    const openBeads = beads.list(projectPath, { status: "open" });
    const inProgressBeads = beads.list(projectPath, { status: "in_progress" });
    const blockedBeads = beads.list(projectPath, { status: "blocked" });
    const deferredBeads = beads.list(projectPath, { status: "deferred" });
    projectBeads = [...openBeads, ...inProgressBeads, ...blockedBeads, ...deferredBeads];
  }

  // Build tree: separate epics from standalone tasks
  const epicBeads = projectBeads.filter((b) => b.type === "epic");
  const childIds = new Set<string>();

  // For each epic, gather children
  const items: BacklogItem[] = [];
  for (const epic of epicBeads) {
    const children = getChildBeads(epic.id, projectPath, includeAll);
    for (const child of children) {
      childIds.add(child.bead.id);
    }

    const item = buildBacklogItem(epic, children, projectName);
    items.push(item);
  }

  // Add standalone tasks (no parent, not a child of any epic we've seen)
  const standalone = projectBeads.filter(
    (b) => b.type !== "epic" && !b.parent && !childIds.has(b.id)
  );
  for (const bead of standalone) {
    const item = buildBacklogItem(bead, [], projectName);
    items.push(item);
  }

  // Filter out closed dependencies from blockedBy annotations
  pruneClosedBlockers(items, projectPath);

  // Sort: in_progress first, then open/blocked, then closed
  items.sort(sortBacklogItems);

  // Build summary
  const summary = buildSummary(items);

  return { project: projectName, items, summary };
}

/**
 * Format backlog data as a printable string
 */
export function formatBacklog(data: BacklogData): string {
  const lines: string[] = [];

  lines.push(data.project);
  lines.push("");

  if (data.items.length === 0) {
    lines.push("  No open beads.");
    lines.push("");
    return lines.join("\n");
  }

  for (const item of data.items) {
    lines.push(formatTopLevelItem(item));

    for (let i = 0; i < item.children.length; i++) {
      const child = item.children[i];
      const isLast = i === item.children.length - 1;
      lines.push(formatChildItem(child, isLast));
    }

    lines.push("");
  }

  // Summary line
  const parts: string[] = [];
  if (data.summary.open > 0) parts.push(`${data.summary.open} open`);
  if (data.summary.inProgress > 0) parts.push(`${data.summary.inProgress} in progress`);
  if (data.summary.blocked > 0) parts.push(`${data.summary.blocked} blocked`);
  if (data.summary.closed > 0) parts.push(`${data.summary.closed} closed`);
  lines.push(`  ${parts.join(" · ")}`);

  return lines.join("\n");
}

// === Internal Helpers ===

/**
 * Remove closed beads from blockedBy annotations.
 *
 * The dependencies list on a bead is a historical record — it includes
 * deps that have since been closed. We only want to show blockers
 * that are still open.
 */
function pruneClosedBlockers(items: BacklogItem[], projectPath: string): void {
  // Collect all unique blocker IDs
  const allBlockerIds = new Set<string>();
  function collectIds(item: BacklogItem): void {
    for (const id of item.blockedBy ?? []) {
      allBlockerIds.add(id);
    }
    for (const child of item.children) {
      collectIds(child);
    }
  }
  for (const item of items) {
    collectIds(item);
  }

  if (allBlockerIds.size === 0) return;

  // Look up which blockers are closed
  const closedIds = new Set<string>();
  for (const id of allBlockerIds) {
    try {
      const bead = beads.show(id, projectPath);
      if (bead.status === "closed" || bead.status === "tombstone") {
        closedIds.add(id);
      }
    } catch {
      // Bead not found — treat as resolved
      closedIds.add(id);
    }
  }

  if (closedIds.size === 0) return;

  // Prune closed IDs from all items
  function prune(item: BacklogItem): void {
    if (item.blockedBy) {
      item.blockedBy = item.blockedBy.filter((id) => !closedIds.has(id));
      if (item.blockedBy.length === 0) {
        item.blockedBy = undefined;
      }
    }
    for (const child of item.children) {
      prune(child);
    }
  }
  for (const item of items) {
    prune(item);
  }
}

/**
 * Get child beads for an epic using bd show --json (includes closed children)
 */
function getChildBeads(
  epicId: string,
  projectPath: string,
  includeAll: boolean
): BacklogItem[] {
  try {
    const raw = execSync(`bd show ${epicId} --json`, {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();

    const data = JSON.parse(raw) as Array<{
      dependents?: Array<{
        id: string;
        title: string;
        status: string;
        issue_type: string;
        priority: number;
        labels?: string[];
        parent?: string;
        dependencies?: unknown[];
        dependency_type?: string;
        created_at: string;
        updated_at: string;
      }>;
    }>;

    const dependents = data[0]?.dependents ?? [];

    return dependents
      .filter((dep) => {
        // Only include parent-child relationships, not "blocks" dependencies
        if (dep.dependency_type && dep.dependency_type !== "parent-child") {
          return false;
        }
        if (includeAll) return true;
        return dep.status !== "closed" && dep.status !== "tombstone";
      })
      .map((dep) => {
        const deps = dep.dependencies || [];
        return {
          bead: {
            id: dep.id,
            title: dep.title,
            description: "",
            type: (dep.issue_type || "task") as Bead["type"],
            status: dep.status as Bead["status"],
            priority: dep.priority ?? 2,
            labels: dep.labels || [],
            parent: dep.parent,
            dependencies: extractBlockedBy(deps) || [],
            created_at: dep.created_at || "",
            updated_at: dep.updated_at || "",
          },
          children: [],
          blockedBy: extractBlockedBy(deps),
        };
      });
  } catch {
    // Fallback: try bd list --parent
    try {
      const children = beads.list(projectPath, { parent: epicId });
      return children
        .filter((b) => {
          if (includeAll) return true;
          return b.status !== "closed" && b.status !== "tombstone";
        })
        .map((b) => ({
          bead: b,
          children: [],
          blockedBy: extractBlockedBy(b.dependencies),
        }));
    } catch {
      return [];
    }
  }
}

/**
 * Build a BacklogItem with workflow overlay
 */
function buildBacklogItem(
  bead: Bead,
  children: BacklogItem[],
  projectName: string
): BacklogItem {
  const item: BacklogItem = {
    bead,
    children,
    blockedBy: extractBlockedBy(bead.dependencies),
  };

  // Overlay workflow state from orchestrator
  try {
    const workflow = getWorkflowForSource(projectName, bead.id);
    if (workflow) {
      const orchestratorPath = getOrchestratorPath();
      const stepInfo = getWorkflowStepInfo(workflow.id, orchestratorPath);

      if (workflow.status === "closed") {
        item.workflowStatus = "done";
      } else if (workflow.status === "blocked") {
        // Check if it's errored vs legitimately blocked
        const epicBead = beads.show(workflow.id, orchestratorPath);
        const isErrored = epicBead.labels.some((l) => l.startsWith("errored:"));
        item.workflowStatus = isErrored ? "errored" : "blocked";
      } else {
        item.workflowStatus = "active";
      }

      if (stepInfo) {
        item.activeAgent = stepInfo.agent;
        item.activeStepNumber = stepInfo.stepNumber;
        item.prNumber = stepInfo.prNumber;
        item.ciStatus = stepInfo.ciStatus ?? undefined;
        item.hasQuestion = stepInfo.hasQuestion;
      }
    }
  } catch {
    // Workflow overlay is best-effort
  }

  return item;
}

interface StepInfo {
  agent: string;
  stepNumber: number;
  prNumber: number | null;
  ciStatus: string | null;
  hasQuestion: boolean;
}

/**
 * Get the latest step info from a workflow epic
 */
function getWorkflowStepInfo(
  epicId: string,
  orchestratorPath: string
): StepInfo | null {
  try {
    const raw = execSync(`bd show ${epicId} --json`, {
      cwd: orchestratorPath,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();

    const data = JSON.parse(raw) as Array<{
      dependents?: Array<{
        id: string;
        title: string;
        status: string;
        labels?: string[];
      }>;
    }>;

    const steps = (data[0]?.dependents ?? []).filter((d) =>
      d.labels?.includes("whs:step")
    );

    if (steps.length === 0) return null;

    // Find the latest non-closed step, or use the last step
    const activeStep =
      steps.find((s) => s.status === "open" || s.status === "in_progress") ??
      steps[steps.length - 1];

    const labels = activeStep.labels || [];
    const agentLabel = labels.find((l) => l.startsWith("agent:"));
    const agent = agentLabel ? agentLabel.slice(6) : activeStep.title;

    let prNumber: number | null = null;
    for (const label of labels) {
      if (label.startsWith("pr:")) {
        const num = parseInt(label.slice(3), 10);
        if (!isNaN(num)) prNumber = num;
      }
    }

    let ciStatus: string | null = null;
    for (const label of labels) {
      if (label.startsWith("ci:")) {
        ciStatus = label.slice(3);
      }
    }

    const hasQuestion = steps.some(
      (s) => s.labels?.includes("whs:question") && s.status === "open"
    );

    // Also check if any sibling beads under this epic are questions
    const allDependents = data[0]?.dependents ?? [];
    const hasQuestionBead = allDependents.some(
      (d) => d.labels?.includes("whs:question") && d.status === "open"
    );

    return {
      agent,
      stepNumber: steps.length,
      prNumber,
      ciStatus,
      hasQuestion: hasQuestion || hasQuestionBead,
    };
  } catch {
    return null;
  }
}

/**
 * Extract blocked-by bead IDs from dependencies.
 *
 * The beads CLI returns dependencies as objects with an `id` field
 * (e.g., { id: "bb-72i", title: "...", ... }), not plain strings.
 * Handle both formats defensively.
 */
function extractBlockedBy(dependencies: unknown[]): string[] | undefined {
  if (!dependencies || dependencies.length === 0) return undefined;

  const ids: string[] = [];
  for (const dep of dependencies) {
    if (typeof dep === "string") {
      ids.push(dep);
    } else if (typeof dep === "object" && dep !== null) {
      const obj = dep as Record<string, unknown>;
      // bd list returns { depends_on_id, type, ... }
      // bd show returns { id, dependency_type, ... }
      const id = obj.depends_on_id ?? obj.id;
      if (typeof id === "string") {
        // Skip parent-child deps (those aren't "blocked by" — they're structural)
        const depType = obj.type ?? obj.dependency_type;
        if (depType === "parent-child") continue;
        ids.push(id);
      }
    }
  }

  return ids.length > 0 ? ids : undefined;
}

/**
 * Sort backlog items: in_progress first, then open/blocked, then closed
 */
function sortBacklogItems(a: BacklogItem, b: BacklogItem): number {
  const statusOrder: Record<string, number> = {
    in_progress: 0,
    open: 1,
    blocked: 2,
    deferred: 3,
    closed: 4,
    tombstone: 5,
    pinned: 6,
  };
  const aOrder = statusOrder[a.bead.status] ?? 3;
  const bOrder = statusOrder[b.bead.status] ?? 3;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.bead.priority - b.bead.priority;
}

/**
 * Build summary counts from items (including children)
 */
function buildSummary(items: BacklogItem[]): BacklogSummary {
  const summary: BacklogSummary = { open: 0, inProgress: 0, closed: 0, blocked: 0 };

  function count(item: BacklogItem): void {
    switch (item.bead.status) {
      case "open":
      case "deferred":
        summary.open++;
        break;
      case "in_progress":
        summary.inProgress++;
        break;
      case "blocked":
        summary.blocked++;
        break;
      case "closed":
      case "tombstone":
        summary.closed++;
        break;
    }
    for (const child of item.children) {
      count(child);
    }
  }

  for (const item of items) {
    count(item);
  }

  return summary;
}

// === Formatters ===

/**
 * Format a top-level item (epic or standalone task)
 */
function formatTopLevelItem(item: BacklogItem): string {
  const icon = getStatusIcon(item);
  const id = item.bead.id;
  const title = item.bead.title;
  const annotation = buildAnnotation(item);

  // For epics, show as a header with status badge
  if (item.bead.type === "epic") {
    const statusBadge = formatStatusBadge(item);
    const annotationStr = annotation ? `  ${annotation}` : "";
    return `  ${title} (${id})${statusBadge}${annotationStr}`;
  }

  // Standalone task
  const annotationStr = annotation ? `  ${annotation}` : "";
  return `  ${icon} ${title} (${id})${annotationStr}`;
}

/**
 * Format a child item with tree connector
 */
function formatChildItem(item: BacklogItem, isLast: boolean): string {
  const icon = getStatusIcon(item);
  const connector = isLast ? "└─" : "├─";
  const id = item.bead.id;
  const title = item.bead.title;
  const annotation = buildAnnotation(item);
  const annotationStr = annotation ? `  ${annotation}` : "";

  return `   ${connector} ${icon} ${title} (${id})${annotationStr}`;
}

/**
 * Get the status icon for an item
 */
function getStatusIcon(item: BacklogItem): string {
  if (item.hasQuestion) return STATUS_ICONS.question;
  return STATUS_ICONS[item.bead.status] || "⏳";
}

/**
 * Format the status badge for an epic (right-aligned bracket)
 */
function formatStatusBadge(item: BacklogItem): string {
  const status = item.bead.status;
  return `  [${status}]`;
}

/**
 * Build the annotation string (PR, CI, blocked by, active agent)
 */
function buildAnnotation(item: BacklogItem): string {
  const parts: string[] = [];

  // PR info
  if (item.prNumber) {
    const prPart = `PR #${item.prNumber}`;
    if (item.ciStatus === "passed") {
      parts.push(`${prPart} merged`);
    } else if (item.ciStatus === "pending") {
      parts.push(`${prPart} · CI pending`);
    } else if (item.ciStatus === "failed") {
      parts.push(`${prPart} · CI failed`);
    } else {
      parts.push(prPart);
    }
  }

  // Active agent
  if (item.activeAgent && item.activeStepNumber && !item.prNumber) {
    parts.push(`${item.activeAgent} step ${item.activeStepNumber}`);
  }

  // Blocked by
  if (
    item.blockedBy &&
    item.blockedBy.length > 0 &&
    item.bead.status !== "closed"
  ) {
    parts.push(`blocked by ${item.blockedBy.join(", ")}`);
  }

  // Workflow status overlay
  if (item.workflowStatus === "errored") {
    parts.push("errored");
  }

  return parts.join(" · ");
}
