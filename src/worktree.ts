/**
 * Worktree Management - Worktrunk CLI wrapper
 *
 * Wraps the `wt` (worktrunk) CLI for git worktree management.
 * Each task gets its own worktree for isolation.
 */

import { execSync, type ExecSyncOptions } from "child_process";
import { getProject, expandPath } from "./config.js";

/**
 * Worktree information from worktrunk
 */
export interface Worktree {
  branch: string;
  path: string;
  kind: "worktree" | "branch";
  isMain: boolean;
  isCurrent: boolean;
  commit?: {
    sha: string;
    shortSha: string;
    message: string;
  };
  workingTree?: {
    staged: boolean;
    modified: boolean;
    untracked: boolean;
  };
  mainState?:
    | "is_main"
    | "integrated"
    | "ahead"
    | "behind"
    | "diverged"
    | "empty";
}

/**
 * Raw JSON output from wt list
 */
interface WtListItem {
  branch: string;
  path: string;
  kind: "worktree" | "branch";
  is_main: boolean;
  is_current: boolean;
  commit?: {
    sha: string;
    short_sha: string;
    message: string;
  };
  working_tree?: {
    staged: boolean;
    modified: boolean;
    untracked: boolean;
  };
  main_state?: string;
}

/**
 * WHS worktree path template.
 *
 * Creates worktrees in a sibling directory:
 *   ~/work/myproject/ → ~/work/myproject-worktrees/bd-123/
 *
 * This keeps worktrees organized and separate from the main checkout.
 */
const WHS_WORKTREE_PATH_TEMPLATE =
  "{{ repo_path }}-worktrees/{{ branch | sanitize }}";

/**
 * Executes a worktrunk command
 */
function execWt(
  args: string[],
  cwd: string,
  options?: { ignoreError?: boolean }
): string {
  const command = `wt ${args.join(" ")}`;
  const execOptions: ExecSyncOptions = {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WORKTRUNK_WORKTREE_PATH: WHS_WORKTREE_PATH_TEMPLATE,
    },
  };

  try {
    return (execSync(command, execOptions) as string).trim();
  } catch (error) {
    if (options?.ignoreError) {
      return "";
    }
    const err = error as Error & { stderr?: Buffer | string };
    const stderr = err.stderr?.toString() || err.message;
    throw new Error(`Worktrunk command failed: ${command}\n${stderr}`);
  }
}

/**
 * Gets the project path from config
 */
function getProjectPath(projectName: string): string {
  const project = getProject(projectName);
  if (!project) {
    throw new Error(`Project not found in config: ${projectName}`);
  }
  return expandPath(project.repoPath);
}

/**
 * Ensures a worktree exists for a bead, creating if needed
 *
 * Returns the path to the worktree.
 */
export function ensureWorktree(
  projectName: string,
  beadId: string,
  options?: { baseBranch?: string }
): string {
  const projectPath = getProjectPath(projectName);

  // Check if worktree already exists
  const existing = getWorktree(projectName, beadId);
  if (existing) {
    return existing.path;
  }

  // Create new worktree with branch — if the branch already exists
  // (e.g., from a previous agent run), switch to it without --create
  const createArgs = ["switch", "--create", beadId];
  if (options?.baseBranch) {
    createArgs.push("--base", options.baseBranch);
  }

  try {
    execWt(createArgs, projectPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already exists")) {
      execWt(["switch", beadId], projectPath);
    } else {
      throw err;
    }
  }

  // Get the path of the newly created worktree
  const worktree = getWorktree(projectName, beadId);
  if (!worktree) {
    throw new Error(`Failed to create worktree for ${beadId}`);
  }

  return worktree.path;
}

/**
 * Gets a specific worktree by branch name or path.
 *
 * Checks branch name first, then falls back to matching the worktree path.
 * This handles agents that rename their branch (e.g., bai-zv0.6 →
 * feature/action-items-task-view) — the path still ends with the bead ID.
 */
export function getWorktree(
  projectName: string,
  branchName: string
): Worktree | null {
  const worktrees = listWorktrees(projectName);
  return (
    worktrees.find((w) => w.branch === branchName) ||
    worktrees.find((w) => w.path.endsWith(`/${branchName}`)) ||
    null
  );
}

/**
 * Lists all worktrees for a project
 */
export function listWorktrees(projectName: string): Worktree[] {
  const projectPath = getProjectPath(projectName);

  try {
    const output = execWt(["list", "--format=json"], projectPath);
    const items = JSON.parse(output) as WtListItem[];

    return items
      .filter((item) => item.kind === "worktree")
      .map((item) => ({
        branch: item.branch,
        path: item.path,
        kind: item.kind,
        isMain: item.is_main,
        isCurrent: item.is_current,
        commit: item.commit
          ? {
              sha: item.commit.sha,
              shortSha: item.commit.short_sha,
              message: item.commit.message,
            }
          : undefined,
        workingTree: item.working_tree,
        mainState: item.main_state as Worktree["mainState"],
      }));
  } catch {
    return [];
  }
}

/**
 * Removes a worktree
 *
 * Deletes the branch if it's been merged.
 */
export function removeWorktree(
  projectName: string,
  branchName: string,
  options?: { force?: boolean }
): boolean {
  const projectPath = getProjectPath(projectName);

  // Check if worktree exists
  const worktree = getWorktree(projectName, branchName);
  if (!worktree) {
    return false;
  }

  // Can't remove main worktree
  if (worktree.isMain) {
    throw new Error(`Cannot remove main worktree: ${branchName}`);
  }

  const args = ["remove", branchName, "--foreground"];
  if (options?.force) {
    args.push("--force");
  }

  try {
    execWt(args, projectPath);
    return true;
  } catch (err) {
    // If force wasn't used and there are uncommitted changes, suggest force
    if (!options?.force) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("uncommitted") ||
        message.includes("unmerged") ||
        message.includes("modified")
      ) {
        throw new Error(
          `Worktree has uncommitted changes. Use force option to remove anyway.`
        );
      }
    }
    throw err;
  }
}

/**
 * Merges a worktree's branch into the target branch
 *
 * By default merges into the main/default branch.
 */
export function mergeWorktree(
  projectName: string,
  branchName: string,
  options?: {
    target?: string;
    squash?: boolean;
    deleteAfter?: boolean;
  }
): void {
  const projectPath = getProjectPath(projectName);

  // First switch to the worktree we want to merge
  const worktree = getWorktree(projectName, branchName);
  if (!worktree) {
    throw new Error(`Worktree not found: ${branchName}`);
  }

  // Run merge from the worktree directory
  const args = ["merge"];

  if (options?.target) {
    args.push("--target", options.target);
  }
  if (options?.squash) {
    args.push("--squash");
  }
  if (options?.deleteAfter) {
    args.push("--delete");
  }

  execWt(args, worktree.path);
}

/**
 * Switches to a worktree (changes current directory context)
 *
 * Note: This doesn't actually change the shell's directory,
 * it returns the path for the caller to use.
 */
export function switchWorktree(
  projectName: string,
  branchName: string
): string {
  const worktree = getWorktree(projectName, branchName);
  if (!worktree) {
    throw new Error(`Worktree not found: ${branchName}`);
  }
  return worktree.path;
}

/**
 * Gets the main/default worktree for a project
 */
export function getMainWorktree(projectName: string): Worktree | null {
  const worktrees = listWorktrees(projectName);
  return worktrees.find((w) => w.isMain) || null;
}

/**
 * Gets the current worktree for a project
 */
export function getCurrentWorktree(projectName: string): Worktree | null {
  const worktrees = listWorktrees(projectName);
  return worktrees.find((w) => w.isCurrent) || null;
}

/**
 * Checks if a worktree has uncommitted changes
 */
export function hasUncommittedChanges(
  projectName: string,
  branchName: string
): boolean {
  const worktree = getWorktree(projectName, branchName);
  if (!worktree?.workingTree) {
    return false;
  }

  return (
    worktree.workingTree.modified ||
    worktree.workingTree.staged ||
    worktree.workingTree.untracked
  );
}

/**
 * Checks if a worktree's branch is integrated (merged) into main
 */
export function isIntegrated(projectName: string, branchName: string): boolean {
  const worktree = getWorktree(projectName, branchName);
  if (!worktree) {
    return false;
  }

  return (
    worktree.mainState === "integrated" || worktree.mainState === "is_main"
  );
}

/**
 * Gets worktrees that are safe to remove (integrated and no uncommitted changes)
 */
export function getRemovableWorktrees(projectName: string): Worktree[] {
  const worktrees = listWorktrees(projectName);

  return worktrees.filter((w) => {
    // Don't suggest removing main
    if (w.isMain) return false;

    // Check if integrated
    if (w.mainState !== "integrated" && w.mainState !== "empty") return false;

    // Check for uncommitted changes
    if (w.workingTree) {
      if (
        w.workingTree.modified ||
        w.workingTree.staged ||
        w.workingTree.untracked
      ) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Gets the worktree base path for a project
 *
 * WHS configures worktrunk to create worktrees in a sibling directory:
 *   ~/work/project/ → ~/work/project-worktrees/
 *
 * Individual worktrees are subdirectories:
 *   ~/work/project-worktrees/bd-123/
 *   ~/work/project-worktrees/bd-456/
 */
export function getWorktreeBasePath(projectName: string): string {
  const projectPath = getProjectPath(projectName);
  return `${projectPath}-worktrees`;
}

/**
 * Cleans up all removable worktrees for a project
 */
export function cleanupWorktrees(projectName: string): string[] {
  const removable = getRemovableWorktrees(projectName);
  const removed: string[] = [];

  for (const worktree of removable) {
    try {
      removeWorktree(projectName, worktree.branch);
      removed.push(worktree.branch);
    } catch {
      // Continue with others even if one fails
    }
  }

  return removed;
}
