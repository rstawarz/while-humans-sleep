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
    if (options?.status) args.push("--status", options.status);
    if (options?.labels?.length) {
      for (const label of options.labels) {
        args.push("--label", label);
      }
    }
    if (options?.description) {
      args.push("--description", `"${this.escapeQuotes(options.description)}"`);
    }

    return this.exec(args, cwd) as Bead;
  }

  /**
   * Update a bead
   */
  update(id: string, cwd: string, options: BeadUpdateOptions): Bead {
    const args = ["update", id];

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

    return this.exec(args, cwd) as Bead;
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
  init(cwd: string, stealth: boolean = false): void {
    const args = ["init"];
    if (stealth) args.push("--stealth");
    this.execRaw(args, cwd);
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

  /**
   * Escape double quotes in strings for shell commands
   */
  private escapeQuotes(str: string): string {
    return str.replace(/"/g, '\\"');
  }
}

// Export singleton instance for convenience
export const beads = new BeadsClient();
