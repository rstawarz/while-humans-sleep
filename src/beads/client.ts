/**
 * Beads CLI wrapper
 *
 * Wraps the `bd` CLI commands and returns typed results.
 * All methods require a `cwd` parameter to specify which project's beads to operate on.
 */

import { execSync, type ExecSyncOptions } from "child_process";
import type { Bead, BeadCreateOptions, BeadUpdateOptions, BeadListOptions } from "./types.js";

export class BeadsClient {
  /**
   * Execute a bd command and return parsed JSON output
   */
  private exec(args: string[], cwd: string): unknown {
    const command = `bd ${args.join(" ")} --json`;
    const options: ExecSyncOptions = {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    };

    try {
      const output = execSync(command, options) as string;
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
  private execRaw(args: string[], cwd: string): string {
    const command = `bd ${args.join(" ")}`;
    const options: ExecSyncOptions = {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    };

    try {
      return (execSync(command, options) as string).trim();
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
    if (options?.labelNone?.length) args.push("--label-none", options.labelNone.join(","));

    return this.exec(args, cwd) as Bead[];
  }

  /**
   * Get a specific bead by ID
   */
  show(id: string, cwd: string): Bead {
    return this.exec(["show", id], cwd) as Bead;
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
    if (options?.labelAll?.length) args.push("--label-all", options.labelAll.join(","));
    if (options?.labelNone?.length) args.push("--label-none", options.labelNone.join(","));

    return this.exec(args, cwd) as Bead[];
  }

  /**
   * Create a new bead
   */
  create(title: string, cwd: string, options?: BeadCreateOptions): Bead {
    const args = ["create", `"${this.escapeQuotes(title)}"`];

    if (options?.type) args.push("-t", options.type);
    if (options?.priority !== undefined) args.push("-p", String(options.priority));
    if (options?.parent) args.push("--parent", options.parent);
    // Note: bd create doesn't support --status, issues are created as "open"
    if (options?.labels?.length) {
      for (const label of options.labels) {
        args.push("--label", label);
      }
    }
    if (options?.description) {
      args.push("--description", `"${this.escapeQuotes(options.description)}"`);
    }

    const bead = this.exec(args, cwd) as Bead;

    // If a non-open status was requested, update the bead after creation
    if (options?.status && options.status !== "open") {
      return this.update(bead.id, cwd, { status: options.status });
    }

    return bead;
  }

  /**
   * Update a bead
   */
  update(id: string, cwd: string, options: BeadUpdateOptions): Bead {
    const args = ["update", id];
    // Note: bd update returns an array, we extract the first element

    if (options.title) args.push("--title", `"${this.escapeQuotes(options.title)}"`);
    if (options.description) args.push("--description", `"${this.escapeQuotes(options.description)}"`);
    if (options.priority !== undefined) args.push("--priority", String(options.priority));
    if (options.status) args.push("--status", options.status);
    if (options.labelAdd?.length) {
      for (const label of options.labelAdd) {
        args.push("--label-add", label);
      }
    }
    if (options.labelRemove?.length) {
      for (const label of options.labelRemove) {
        args.push("--label-remove", label);
      }
    }

    // bd update returns an array, extract first element
    const result = this.exec(args, cwd) as Bead[];
    return result[0];
  }

  /**
   * Close a bead with a reason
   */
  close(id: string, reason: string, cwd: string): Bead {
    return this.exec(["close", id, "--reason", `"${this.escapeQuotes(reason)}"`], cwd) as Bead;
  }

  /**
   * Add a comment to a bead
   */
  comment(id: string, text: string, cwd: string): void {
    this.execRaw(["comment", id, `"${this.escapeQuotes(text)}"`], cwd);
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
      this.configSet("sync.branch", syncBranch, cwd);
    }

    // Start daemon if not running
    if (!this.isDaemonRunning(cwd)) {
      this.daemonStart(cwd, { autoCommit: true });
    }
  }

  /**
   * Escape double quotes in strings for shell commands
   */
  private escapeQuotes(str: string): string {
    return str.replace(/"/g, '\\"');
  }
}

// Export singleton instance for convenience
export const beads = new BeadsClient();
