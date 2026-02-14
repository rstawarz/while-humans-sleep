/**
 * Beads CLI wrapper
 *
 * Wraps the `bd` CLI commands and returns typed results.
 * All methods require a `cwd` parameter to specify which project's beads to operate on.
 *
 * Uses execFileSync (no shell) to avoid metacharacter issues with descriptions
 * containing newlines, quotes, backticks, etc. Descriptions are passed via
 * --body-file - (stdin) to avoid ARG_MAX limits on large content.
 */

import { execFileSync } from "child_process";
import type { Bead, BeadCreateOptions, BeadUpdateOptions, BeadListOptions, RawBead } from "./types.js";
import { normalizeBead } from "./types.js";

export class BeadsClient {
  /**
   * Execute a bd command and return parsed JSON output
   */
  private exec(args: string[], cwd: string, stdin?: string): unknown {
    try {
      const output = execFileSync("bd", [...args, "--json"], {
        cwd,
        encoding: "utf-8",
        stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        input: stdin,
      });
      return JSON.parse(output.trim());
    } catch (error) {
      const err = error as Error & { stderr?: Buffer | string };
      const stderr = err.stderr?.toString() || err.message;
      throw new Error(`Beads command failed: bd ${args.join(" ")}\n${stderr}`);
    }
  }

  /**
   * Execute a bd command without expecting JSON output
   */
  private execRaw(args: string[], cwd: string, stdin?: string): string {
    try {
      return execFileSync("bd", args, {
        cwd,
        encoding: "utf-8",
        stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        input: stdin,
      }).trim();
    } catch (error) {
      const err = error as Error & { stderr?: Buffer | string };
      const stderr = err.stderr?.toString() || err.message;
      throw new Error(`Beads command failed: bd ${args.join(" ")}\n${stderr}`);
    }
  }

  /**
   * Get tasks that are ready to work on (no blocking dependencies)
   */
  ready(cwd: string, options?: BeadListOptions): Bead[] {
    const args = ["ready"];

    if (options?.type) args.push("--type", options.type);
    if (options?.priority !== undefined) args.push("--priority", String(options.priority));
    if (options?.priorityMin !== undefined) args.push("--priority-min", String(options.priorityMin));
    if (options?.priorityMax !== undefined) args.push("--priority-max", String(options.priorityMax));
    if (options?.labelAny?.length) args.push("--label-any", options.labelAny.join(","));
    // --label (or -l) is the AND filter in beads CLI
    if (options?.labelAll?.length) args.push("--label", options.labelAll.join(","));
    if (options?.labelNone?.length) args.push("--label-none", options.labelNone.join(","));

    const raw = this.exec(args, cwd) as RawBead[];
    return raw.map(normalizeBead);
  }

  /**
   * Get a specific bead by ID
   */
  show(id: string, cwd: string): Bead {
    // bd show returns an array with one element
    const raw = this.exec(["show", id], cwd) as RawBead[];
    return normalizeBead(raw[0]);
  }

  /**
   * List beads with optional filters
   */
  list(cwd: string, options?: BeadListOptions): Bead[] {
    const args = ["list"];

    if (options?.status) args.push("--status", options.status);
    if (options?.type) args.push("--type", options.type);
    if (options?.parent) args.push("--parent", options.parent);
    if (options?.priority !== undefined) args.push("--priority", String(options.priority));
    if (options?.priorityMin !== undefined) args.push("--priority-min", String(options.priorityMin));
    if (options?.priorityMax !== undefined) args.push("--priority-max", String(options.priorityMax));
    if (options?.labelAny?.length) args.push("--label-any", options.labelAny.join(","));
    // --label (or -l) is the AND filter in beads CLI
    if (options?.labelAll?.length) args.push("--label", options.labelAll.join(","));
    if (options?.labelNone?.length) args.push("--label-none", options.labelNone.join(","));
    if (options?.sort) args.push("--sort", options.sort);
    if (options?.reverse) args.push("--reverse");

    const raw = this.exec(args, cwd) as RawBead[];
    return raw.map(normalizeBead);
  }

  /**
   * Create a new bead
   *
   * Descriptions are passed via --body-file - (stdin) to handle arbitrary
   * content including newlines, quotes, backticks, and shell metacharacters.
   */
  create(title: string, cwd: string, options?: BeadCreateOptions): Bead {
    const args = ["create", title];

    if (options?.type) args.push("-t", options.type);
    if (options?.priority !== undefined) args.push("-p", String(options.priority));
    if (options?.parent) args.push("--parent", options.parent);
    // Note: bd create doesn't support --status, issues are created as "open"
    if (options?.labels?.length) {
      for (const label of options.labels) {
        args.push("--label", label);
      }
    }

    // Use --body-file - to pipe description via stdin
    let stdin: string | undefined;
    if (options?.description) {
      args.push("--body-file", "-");
      stdin = options.description;
    }

    const raw = this.exec(args, cwd, stdin) as RawBead;

    // bd create doesn't return labels in JSON output, so fetch the full bead
    // Also handles non-open status via update if needed
    if (options?.status && options.status !== "open") {
      return this.update(raw.id, cwd, { status: options.status });
    }

    // If labels were set, fetch the bead to get the complete data
    if (options?.labels?.length) {
      return this.show(raw.id, cwd);
    }

    return normalizeBead(raw);
  }

  /**
   * Update a bead
   *
   * Descriptions are passed via --body-file - (stdin) to handle arbitrary content.
   */
  update(id: string, cwd: string, options: BeadUpdateOptions): Bead {
    const args = ["update", id];

    if (options.title) args.push("--title", options.title);
    if (options.priority !== undefined) args.push("--priority", String(options.priority));
    if (options.status) args.push("--status", options.status);
    if (options.labelAdd?.length) {
      for (const label of options.labelAdd) {
        args.push("--add-label", label);
      }
    }
    if (options.labelRemove?.length) {
      for (const label of options.labelRemove) {
        args.push("--remove-label", label);
      }
    }

    // Use --body-file - to pipe description via stdin
    let stdin: string | undefined;
    if (options.description) {
      args.push("--body-file", "-");
      stdin = options.description;
    }

    // bd update returns an array, extract first element
    const raw = this.exec(args, cwd, stdin) as RawBead[];
    return normalizeBead(raw[0]);
  }

  /**
   * Close a bead with a reason
   */
  close(id: string, reason: string, cwd: string): Bead {
    const raw = this.exec(["close", id, "--reason", reason], cwd) as RawBead[];
    return normalizeBead(raw[0]);
  }

  /**
   * Add a comment to a bead
   */
  comment(id: string, text: string, cwd: string): void {
    this.execRaw(["comments", "add", id, text], cwd);
  }

  /**
   * List comments on a bead
   */
  listComments(id: string, cwd: string): Array<{ id: number; issue_id: string; author: string; text: string; created_at: string }> {
    try {
      return this.exec(["comments", id], cwd) as Array<{ id: number; issue_id: string; author: string; text: string; created_at: string }>;
    } catch {
      return [];
    }
  }

  /**
   * Add a dependency between beads
   */
  depAdd(childId: string, parentId: string, cwd: string): void {
    this.execRaw(["dep", "add", childId, parentId], cwd);
  }

  /**
   * Remove a dependency between beads
   */
  depRemove(childId: string, parentId: string, cwd: string): void {
    this.execRaw(["dep", "remove", childId, parentId], cwd);
  }

  /**
   * Force sync beads (commit and push)
   */
  sync(cwd: string): void {
    this.execRaw(["sync"], cwd);
  }

  /**
   * Initialize beads in a project
   */
  init(cwd: string, options?: { stealth?: boolean; prefix?: string }): void {
    const args = ["init"];
    if (options?.stealth) args.push("--stealth");
    if (options?.prefix) args.push("-p", options.prefix);
    this.execRaw(args, cwd);
  }

  /**
   * Set the issue prefix for an existing beads repo
   */
  setPrefix(prefix: string, cwd: string): void {
    this.configSet("issue_prefix", prefix, cwd);
  }

  /**
   * Get the current issue prefix
   */
  getPrefix(cwd: string): string | null {
    return this.configGet("issue_prefix", cwd);
  }

  /**
   * Check if beads is initialized in a directory
   */
  isInitialized(cwd: string): boolean {
    try {
      this.execRaw(["list"], cwd);
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================
  // Configuration
  // ============================================================

  /**
   * Set a beads config value
   */
  configSet(key: string, value: string, cwd: string): void {
    this.execRaw(["config", "set", key, value], cwd);
  }

  /**
   * Get a beads config value
   */
  configGet(key: string, cwd: string): string | null {
    try {
      return this.execRaw(["config", "get", key], cwd);
    } catch {
      return null;
    }
  }

  // ============================================================
  // Daemon Management
  // ============================================================

  /**
   * Start the beads daemon for a project
   */
  daemonStart(cwd: string, options?: { autoCommit?: boolean }): void {
    const args = ["daemon", "start"];
    if (options?.autoCommit) args.push("--auto-commit");
    this.execRaw(args, cwd);
  }

  /**
   * Stop the beads daemon for a project
   */
  daemonStop(cwd: string): void {
    try {
      this.execRaw(["daemon", "stop"], cwd);
    } catch {
      // Daemon might not be running, ignore
    }
  }

  /**
   * Get daemon status for a project
   */
  daemonStatus(cwd: string): { running: boolean; pid?: number } {
    try {
      const output = this.execRaw(["daemon", "status"], cwd);
      const running = output.includes("running");
      const pidMatch = output.match(/PID\s+(\d+)/);
      return {
        running,
        pid: pidMatch ? parseInt(pidMatch[1], 10) : undefined,
      };
    } catch {
      return { running: false };
    }
  }

  /**
   * Check if daemon is running for a project
   */
  isDaemonRunning(cwd: string): boolean {
    return this.daemonStatus(cwd).running;
  }

  /**
   * Ensure daemon is running with sync-branch configured
   *
   * This is the recommended setup for WHS projects:
   * - Configures sync-branch to keep beads commits separate from code
   * - Starts daemon with auto-commit for immediate persistence
   */
  ensureDaemonWithSyncBranch(cwd: string, syncBranch: string = "beads-sync"): void {
    // Configure sync-branch if not already set
    const currentSyncBranch = this.configGet("sync.branch", cwd);
    if (currentSyncBranch !== syncBranch) {
      try {
        this.configSet("sync.branch", syncBranch, cwd);
      } catch {
        // config.yaml may not exist yet — not fatal, daemon can still run
      }
    }

    // Start daemon if not running
    if (!this.isDaemonRunning(cwd)) {
      this.daemonStart(cwd, { autoCommit: true });
    }
  }

  // ============================================================
  // Question Management (questions are beads that block steps)
  // ============================================================

  /**
   * Create a question bead that blocks a workflow step
   *
   * Questions are stored as tasks with the "whs:question" label since
   * beads CLI doesn't have a native "question" type.
   *
   * @param title - Question title (e.g., "Question: Which epic?")
   * @param cwd - Orchestrator path
   * @param data - Structured question data (stored as JSON in description)
   * @param parentEpicId - Parent workflow epic
   * @param blocksStepId - Step ID that this question blocks
   */
  createQuestion(
    title: string,
    cwd: string,
    data: import("../types.js").QuestionBeadData,
    parentEpicId: string,
    blocksStepId: string
  ): Bead {
    // Create question bead as a task with special label
    const question = this.create(title, cwd, {
      type: "task", // Use task type since "question" is not a valid bd type
      parent: parentEpicId,
      description: JSON.stringify(data, null, 2),
      labels: ["whs:question"], // Mark as a question
    });

    // Add dependency: question blocks the step
    this.depAdd(blocksStepId, question.id, cwd);

    return question;
  }

  /**
   * List pending (open) questions in the orchestrator
   *
   * Questions are identified by the "whs:question" label.
   * Returns questions sorted by created date (oldest first).
   */
  listPendingQuestions(cwd: string): Bead[] {
    return this.list(cwd, {
      status: "open",
      labelAll: ["whs:question"],
      sort: "created",
    });
  }

  /**
   * Parse question bead data from description
   */
  parseQuestionData(bead: Bead): import("../types.js").QuestionBeadData {
    return JSON.parse(bead.description);
  }

  /**
   * Answer a question: add comment, close the question bead
   * Note: Caller should mark step as in_progress BEFORE calling this
   */
  answerQuestion(questionId: string, answer: string, cwd: string): void {
    this.comment(questionId, `Answer: ${answer}`, cwd);
    this.close(questionId, "Answered", cwd);
  }

  /**
   * Clean stale entries from the global beads registry
   *
   * The beads CLI stores all initialized workspaces in ~/.beads/registry.json.
   * This method removes entries for directories that no longer exist.
   * Useful for cleaning up after tests or deleted projects.
   */
  static cleanRegistry(): number {
    const homedir = process.env.HOME || process.env.USERPROFILE || "";
    const registryPath = `${homedir}/.beads/registry.json`;

    try {
      const fs = require("fs");
      if (!fs.existsSync(registryPath)) {
        return 0;
      }

      const content = fs.readFileSync(registryPath, "utf-8");
      const entries = JSON.parse(content);

      const validEntries = entries.filter((entry: { workspace_path: string }) => {
        return fs.existsSync(entry.workspace_path);
      });

      const removed = entries.length - validEntries.length;

      if (removed > 0) {
        fs.writeFileSync(registryPath, JSON.stringify(validEntries, null, 2));
      }

      return removed;
    } catch {
      // Ignore errors - registry cleanup is best-effort
      return 0;
    }
  }
}

// Export singleton instance for convenience
export const beads = new BeadsClient();
