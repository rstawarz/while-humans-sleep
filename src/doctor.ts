/**
 * Doctor - Pre-start health checks
 *
 * Checks system health before starting the dispatcher:
 * beads daemons, daemon errors, errored/blocked workflows,
 * CI-pending PR status, orphaned worktrees, and state sanity.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import type { Config } from "./types.js";
import { expandPath } from "./config.js";
import { beads } from "./beads/index.js";
import {
  getErroredWorkflows,
  getStepsPendingCI,
  getSourceBeadInfo,
} from "./workflow.js";
import { listWorktrees } from "./worktree.js";
import { loadState, getLockInfo } from "./state.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  details?: string[];
}

/**
 * Runs all doctor checks and returns results
 */
export async function runDoctorChecks(config: Config): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push(checkBeadsDaemons(config));
  checks.push(checkDaemonErrors(config));
  checks.push(checkErroredWorkflows());
  checks.push(checkBlockedWorkflows(config));
  checks.push(checkCIPendingPRs(config));
  checks.push(checkOrphanedWorktrees(config));
  checks.push(checkStateSanity());

  return checks;
}

/**
 * Check 1: Beads daemons running for all projects + orchestrator
 */
export function checkBeadsDaemons(config: Config): DoctorCheck {
  const notRunning: string[] = [];
  const orchestratorPath = expandPath(config.orchestratorPath);

  for (const project of config.projects) {
    const projectPath = expandPath(project.repoPath);
    const status = beads.daemonStatus(projectPath);
    if (!status.running) {
      notRunning.push(project.name);
    }
  }

  const orchStatus = beads.daemonStatus(orchestratorPath);
  if (!orchStatus.running) {
    notRunning.push("orchestrator");
  }

  if (notRunning.length === 0) {
    return {
      name: "Beads daemons",
      status: "pass",
      message: "all running",
    };
  }

  return {
    name: "Beads daemons",
    status: "fail",
    message: `${notRunning.length} not running`,
    details: notRunning.map((name) => `${name}: not running`),
  };
}

/**
 * Check 2: Daemon error files
 */
export function checkDaemonErrors(config: Config): DoctorCheck {
  const errors: string[] = [];
  const orchestratorPath = expandPath(config.orchestratorPath);

  const paths: Array<{ name: string; path: string }> = config.projects.map(
    (p) => ({ name: p.name, path: expandPath(p.repoPath) })
  );
  paths.push({ name: "orchestrator", path: orchestratorPath });

  for (const { name, path } of paths) {
    const errorFile = join(path, ".beads", "daemon-error");
    if (existsSync(errorFile)) {
      try {
        const content = readFileSync(errorFile, "utf-8").trim();
        errors.push(`${name}: ${content.slice(0, 200)}`);
      } catch {
        errors.push(`${name}: error file exists but could not be read`);
      }
    }
  }

  if (errors.length === 0) {
    return {
      name: "Daemon errors",
      status: "pass",
      message: "no errors",
    };
  }

  return {
    name: "Daemon errors",
    status: "fail",
    message: `${errors.length} daemon error(s)`,
    details: errors,
  };
}

/**
 * Check 3: Errored workflows
 */
export function checkErroredWorkflows(): DoctorCheck {
  const errored = getErroredWorkflows();

  if (errored.length === 0) {
    return {
      name: "Errored workflows",
      status: "pass",
      message: "none",
    };
  }

  return {
    name: "Errored workflows",
    status: "warn",
    message: `${errored.length} errored`,
    details: errored.map(
      (w) => `${w.epicId} (${w.sourceProject}/${w.sourceBeadId}) — ${w.errorType} (suggest: whs retry ${w.epicId})`
    ),
  };
}

/**
 * Check 4: Blocked workflows (blocked:human label)
 */
export function checkBlockedWorkflows(config: Config): DoctorCheck {
  const orchestratorPath = expandPath(config.orchestratorPath);

  try {
    const blocked = beads.list(orchestratorPath, {
      type: "epic",
      labelAny: ["blocked:human"],
    });

    // Filter to only open/blocked (not closed)
    const active = blocked.filter(
      (b) => b.status !== "closed" && b.status !== "tombstone"
    );

    if (active.length === 0) {
      return {
        name: "Blocked workflows",
        status: "pass",
        message: "none",
      };
    }

    const details = active.map((b) => {
      const sourceInfo = getSourceBeadInfo(b.id);
      const source = sourceInfo
        ? `${sourceInfo.project}/${sourceInfo.beadId}`
        : "unknown";

      // Get the last "Blocked:" comment as the reason
      const comments = beads.listComments(b.id, orchestratorPath);
      const blockedComment = [...comments]
        .reverse()
        .find((c) => c.text.startsWith("Blocked:"));
      const reason = blockedComment
        ? blockedComment.text.replace("Blocked: ", "")
        : undefined;

      return reason
        ? `${b.id} (${source}) — ${reason}`
        : `${b.id} (${source})`;
    });

    return {
      name: "Blocked workflows",
      status: "warn",
      message: `${active.length} blocked`,
      details,
    };
  } catch {
    return {
      name: "Blocked workflows",
      status: "pass",
      message: "none (orchestrator not initialized)",
    };
  }
}

/**
 * Check 5: CI-pending PR status
 *
 * For each step pending CI, checks GitHub PR status for conflicts,
 * unexpected states, etc.
 */
export function checkCIPendingPRs(config: Config): DoctorCheck {
  const pendingSteps = getStepsPendingCI();

  if (pendingSteps.length === 0) {
    return {
      name: "CI-pending PRs",
      status: "pass",
      message: "none pending",
    };
  }

  const issues: string[] = [];
  let passedCount = 0;
  let pendingCount = 0;

  for (const step of pendingSteps) {
    const project = config.projects.find((p) => p.name === step.project);
    if (!project) continue;

    const repoPath = expandPath(project.repoPath);

    try {
      const result = execSync(
        `gh pr view ${step.prNumber} --json state,mergeable,statusCheckRollup --jq '{state: .state, mergeable: .mergeable, checks: [.statusCheckRollup[]? | .state] | unique}'`,
        { encoding: "utf-8", timeout: 15000, cwd: repoPath }
      ).trim();

      const data = JSON.parse(result) as {
        state: string;
        mergeable: string;
        checks: string[];
      };

      if (data.state === "MERGED") {
        issues.push(`PR #${step.prNumber}: already merged`);
      } else if (data.state === "CLOSED") {
        issues.push(`PR #${step.prNumber}: closed`);
      } else if (data.mergeable === "CONFLICTING") {
        issues.push(`PR #${step.prNumber}: merge conflicts`);
      } else if (
        data.checks.some(
          (s) => s === "FAILURE" || s === "ERROR" || s === "CANCELLED"
        )
      ) {
        issues.push(`PR #${step.prNumber}: CI failed`);
      } else if (
        data.checks.some(
          (s) => s === "PENDING" || s === "IN_PROGRESS" || s === "QUEUED"
        )
      ) {
        pendingCount++;
      } else {
        passedCount++;
      }
    } catch {
      // gh command failed, skip this PR
      pendingCount++;
    }
  }

  if (issues.length === 0) {
    const parts: string[] = [];
    if (passedCount > 0) parts.push(`${passedCount} passed`);
    if (pendingCount > 0) parts.push(`${pendingCount} pending`);

    return {
      name: "CI-pending PRs",
      status: "pass",
      message: parts.join(", ") || "all ok",
    };
  }

  const parts: string[] = [];
  if (passedCount > 0) parts.push(`${passedCount} passed`);
  if (pendingCount > 0) parts.push(`${pendingCount} pending`);
  parts.push(`${issues.length} issue(s)`);

  return {
    name: "CI-pending PRs",
    status: "warn",
    message: parts.join(", "),
    details: issues,
  };
}

interface UnmanagedWorktree {
  project: string;
  branch: string;
  prNumber?: number;
  prState?: "OPEN" | "MERGED" | "CLOSED";
}

/**
 * Fetch all PRs for a project repo, returning a map of branch name → PR info.
 */
function getPRsByBranch(
  repoPath: string
): Map<string, { number: number; state: "OPEN" | "MERGED" | "CLOSED" }> {
  const result = new Map<
    string,
    { number: number; state: "OPEN" | "MERGED" | "CLOSED" }
  >();

  try {
    const json = execSync(
      "gh pr list --state all --json number,headRefName,state --limit 100",
      { encoding: "utf-8", timeout: 15000, cwd: repoPath }
    ).trim();

    const prs = JSON.parse(json) as Array<{
      number: number;
      headRefName: string;
      state: "OPEN" | "MERGED" | "CLOSED";
    }>;

    for (const pr of prs) {
      // Keep the most recent PR per branch (highest number)
      const existing = result.get(pr.headRefName);
      if (!existing || pr.number > existing.number) {
        result.set(pr.headRefName, { number: pr.number, state: pr.state });
      }
    }
  } catch {
    // gh not available or not in a GitHub repo
  }

  return result;
}

/**
 * Check 6: Unmanaged worktrees
 *
 * Lists worktrees per project and cross-references with orchestrator
 * active workflows. Worktrees with no active workflow have their GitHub
 * PR status checked to determine what action is needed.
 */
export function checkOrphanedWorktrees(config: Config): DoctorCheck {
  const orchestratorPath = expandPath(config.orchestratorPath);
  let activeCount = 0;
  const unmanaged: UnmanagedWorktree[] = [];

  // Get all active workflow epics (open, in_progress, or blocked)
  let activeBeadIds: Set<string>;
  try {
    // Match all workflow epics — new ones have whs:workflow, older ones
    // only have source:* labels. Listing all epics is safe since the
    // orchestrator only contains workflow epics.
    const epics = beads.list(orchestratorPath, {
      type: "epic",
    });

    activeBeadIds = new Set<string>();
    for (const epic of epics) {
      if (epic.status === "closed" || epic.status === "tombstone") continue;
      const sourceInfo = getSourceBeadInfo(epic.id);
      if (sourceInfo) {
        activeBeadIds.add(sourceInfo.beadId);
      }
    }
  } catch {
    // Can't check without orchestrator
    return {
      name: "Worktrees",
      status: "pass",
      message: "skipped (orchestrator not initialized)",
    };
  }

  // Collect unmanaged worktrees per project, then batch-check PRs
  const unmanagedByProject = new Map<
    string,
    Array<{ branch: string; repoPath: string }>
  >();

  for (const project of config.projects) {
    try {
      const worktrees = listWorktrees(project.name);
      const nonMain = worktrees.filter(
        (w) => !w.isMain && !w.path.includes(".git/beads-worktrees")
      );

      for (const wt of nonMain) {
        if (activeBeadIds.has(wt.branch)) {
          activeCount++;
        } else {
          if (!unmanagedByProject.has(project.name)) {
            unmanagedByProject.set(project.name, []);
          }
          unmanagedByProject.get(project.name)!.push({
            branch: wt.branch,
            repoPath: expandPath(project.repoPath),
          });
        }
      }
    } catch {
      // listWorktrees can fail if wt not installed
    }
  }

  // Batch-fetch PR status per project (one gh call per project)
  for (const [projectName, worktrees] of unmanagedByProject) {
    const repoPath = worktrees[0].repoPath;
    const prMap = getPRsByBranch(repoPath);

    for (const wt of worktrees) {
      const pr = prMap.get(wt.branch);
      unmanaged.push({
        project: projectName,
        branch: wt.branch,
        prNumber: pr?.number,
        prState: pr?.state,
      });
    }
  }

  if (unmanaged.length === 0) {
    return {
      name: "Worktrees",
      status: "pass",
      message: `${activeCount} active`,
    };
  }

  // Format details with PR status
  const merged: string[] = [];
  const openPR: string[] = [];
  const noPR: string[] = [];

  for (const wt of unmanaged) {
    if (wt.prState === "MERGED") {
      merged.push(`${wt.project}/${wt.branch}: PR #${wt.prNumber} merged — safe to remove`);
    } else if (wt.prState === "OPEN") {
      openPR.push(`${wt.project}/${wt.branch}: PR #${wt.prNumber} open — needs review/merge`);
    } else if (wt.prState === "CLOSED") {
      merged.push(`${wt.project}/${wt.branch}: PR #${wt.prNumber} closed — safe to remove`);
    } else {
      noPR.push(`${wt.project}/${wt.branch}: no PR`);
    }
  }

  const details = [...openPR, ...noPR, ...merged];
  const parts: string[] = [];
  if (activeCount > 0) parts.push(`${activeCount} active`);
  if (openPR.length > 0) parts.push(`${openPR.length} with open PR`);
  if (merged.length > 0) parts.push(`${merged.length} safe to remove`);
  if (noPR.length > 0) parts.push(`${noPR.length} with no PR`);

  // Only warn if something actually needs manual intervention.
  // Open PRs, merged PRs, and unknown worktrees are informational —
  // the system can handle open PRs via active workflows, and the rest
  // are harmless cleanup candidates.
  const status: DoctorCheck["status"] = "pass";

  return {
    name: "Worktrees",
    status,
    message: parts.join(", "),
    details,
  };
}

/**
 * Check 7: State sanity
 *
 * Checks state.json for paused flag and stale activeWork entries
 * (entries exist but no dispatcher lock is held).
 */
export function checkStateSanity(): DoctorCheck {
  const issues: string[] = [];

  try {
    const state = loadState();
    const lockInfo = getLockInfo();

    if (state.paused) {
      issues.push("paused from previous session");
    }

    if (state.activeWork.size > 0 && !lockInfo) {
      issues.push(
        `${state.activeWork.size} stale activeWork entries (no dispatcher running)`
      );
    }
  } catch {
    // State file doesn't exist or can't be read — that's fine
    return {
      name: "State",
      status: "pass",
      message: "clean (no state file)",
    };
  }

  if (issues.length === 0) {
    return {
      name: "State",
      status: "pass",
      message: "clean",
    };
  }

  return {
    name: "State",
    status: "warn",
    message: issues.join("; "),
    details: issues,
  };
}

/**
 * Formats doctor results for console output
 */
export function formatDoctorResults(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  const icons = { pass: "✓", warn: "⚠", fail: "✗" };

  lines.push("🩺 WHS Doctor");
  lines.push("");

  for (const check of checks) {
    const icon = icons[check.status];
    lines.push(`  ${icon} ${check.name}: ${check.message}`);

    if (check.details && check.details.length > 0) {
      for (const detail of check.details) {
        lines.push(`    ${icon} ${detail}`);
      }
    }
  }

  const warnCount = checks.filter((c) => c.status === "warn").length;
  const failCount = checks.filter((c) => c.status === "fail").length;

  lines.push("");
  if (failCount === 0 && warnCount === 0) {
    lines.push("  Result: all checks passed");
  } else {
    const parts: string[] = [];
    if (warnCount > 0) parts.push(`${warnCount} ${warnCount === 1 ? "warning" : "warnings"}`);
    if (failCount > 0) parts.push(`${failCount} ${failCount === 1 ? "error" : "errors"}`);
    lines.push(`  Result: ${parts.join(", ")}`);
  }

  return lines.join("\n");
}
