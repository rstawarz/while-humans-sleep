/**
 * Tests for Beads CLI wrapper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { BeadsClient } from "./client.js";
import type { Bead } from "./types.js";

// Mock child_process
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

describe("BeadsClient", () => {
  let client: BeadsClient;
  const testCwd = "/test/project";

  beforeEach(() => {
    client = new BeadsClient();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // Sample bead for testing
  const sampleBead: Bead = {
    id: "bd-a1b2",
    title: "Implement auth",
    description: "Add JWT authentication",
    type: "task",
    status: "open",
    priority: 1,
    labels: ["backend"],
    dependencies: [],
    created_at: "2024-01-15T10:00:00Z",
    updated_at: "2024-01-15T10:00:00Z",
  };

  describe("ready", () => {
    it("returns ready tasks as array", () => {
      mockExecSync.mockReturnValue(JSON.stringify([sampleBead]));

      const result = client.ready(testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd ready --json",
        expect.objectContaining({ cwd: testCwd })
      );
      expect(result).toEqual([sampleBead]);
    });

    it("passes type filter", () => {
      mockExecSync.mockReturnValue("[]");

      client.ready(testCwd, { type: "task" });

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd ready --type task --json",
        expect.any(Object)
      );
    });

    it("passes priority filters", () => {
      mockExecSync.mockReturnValue("[]");

      client.ready(testCwd, { priorityMin: 0, priorityMax: 1 });

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd ready --priority-min 0 --priority-max 1 --json",
        expect.any(Object)
      );
    });

    it("passes label-none filter", () => {
      mockExecSync.mockReturnValue("[]");

      client.ready(testCwd, { labelNone: ["planning", "blocked"] });

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd ready --label-none planning,blocked --json",
        expect.any(Object)
      );
    });

    it("returns empty array when no tasks ready", () => {
      mockExecSync.mockReturnValue("[]");

      const result = client.ready(testCwd);

      expect(result).toEqual([]);
    });
  });

  describe("show", () => {
    it("returns bead by id", () => {
      mockExecSync.mockReturnValue(JSON.stringify(sampleBead));

      const result = client.show("bd-a1b2", testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd show bd-a1b2 --json",
        expect.objectContaining({ cwd: testCwd })
      );
      expect(result).toEqual(sampleBead);
    });

    it("throws on invalid id", () => {
      mockExecSync.mockImplementation(() => {
        const error = new Error("Command failed") as Error & { stderr: string };
        error.stderr = "Error: bead not found: bd-invalid";
        throw error;
      });

      expect(() => client.show("bd-invalid", testCwd)).toThrow("Beads command failed");
    });
  });

  describe("list", () => {
    it("lists all beads without filters", () => {
      mockExecSync.mockReturnValue(JSON.stringify([sampleBead]));

      const result = client.list(testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd list --json",
        expect.any(Object)
      );
      expect(result).toEqual([sampleBead]);
    });

    it("passes status filter", () => {
      mockExecSync.mockReturnValue("[]");

      client.list(testCwd, { status: "open" });

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd list --status open --json",
        expect.any(Object)
      );
    });

    it("passes parent filter", () => {
      mockExecSync.mockReturnValue("[]");

      client.list(testCwd, { parent: "bd-epic1" });

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd list --parent bd-epic1 --json",
        expect.any(Object)
      );
    });

    it("passes multiple label filters", () => {
      mockExecSync.mockReturnValue("[]");

      client.list(testCwd, {
        labelAny: ["urgent", "critical"],
        labelAll: ["backend"],
        labelNone: ["wontfix"],
      });

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd list --label-any urgent,critical --label-all backend --label-none wontfix --json",
        expect.any(Object)
      );
    });
  });

  describe("create", () => {
    it("creates bead with title only", () => {
      mockExecSync.mockReturnValue(JSON.stringify(sampleBead));

      const result = client.create("Implement auth", testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        'bd create "Implement auth" --json',
        expect.any(Object)
      );
      expect(result).toEqual(sampleBead);
    });

    it("creates bead with all options", () => {
      mockExecSync.mockReturnValue(JSON.stringify(sampleBead));

      client.create("Implement auth", testCwd, {
        type: "task",
        priority: 1,
        parent: "bd-epic1",
        status: "open",
        labels: ["backend", "urgent"],
        description: "Add JWT authentication",
      });

      expect(mockExecSync).toHaveBeenCalledWith(
        'bd create "Implement auth" -t task -p 1 --parent bd-epic1 --status open --label backend --label urgent --description "Add JWT authentication" --json',
        expect.any(Object)
      );
    });

    it("escapes quotes in title", () => {
      mockExecSync.mockReturnValue(JSON.stringify(sampleBead));

      client.create('Fix "critical" bug', testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        'bd create "Fix \\"critical\\" bug" --json',
        expect.any(Object)
      );
    });
  });

  describe("update", () => {
    it("updates bead with new status", () => {
      const updatedBead = { ...sampleBead, status: "in_progress" as const };
      mockExecSync.mockReturnValue(JSON.stringify(updatedBead));

      const result = client.update("bd-a1b2", testCwd, { status: "in_progress" });

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd update bd-a1b2 --status in_progress --json",
        expect.any(Object)
      );
      expect(result.status).toBe("in_progress");
    });

    it("adds and removes labels", () => {
      mockExecSync.mockReturnValue(JSON.stringify(sampleBead));

      client.update("bd-a1b2", testCwd, {
        labelAdd: ["needs-review"],
        labelRemove: ["wip"],
      });

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd update bd-a1b2 --label-add needs-review --label-remove wip --json",
        expect.any(Object)
      );
    });
  });

  describe("close", () => {
    it("closes bead with reason", () => {
      const closedBead = { ...sampleBead, status: "closed" as const };
      mockExecSync.mockReturnValue(JSON.stringify(closedBead));

      const result = client.close("bd-a1b2", "PR #47 merged", testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        'bd close bd-a1b2 --reason "PR #47 merged" --json',
        expect.any(Object)
      );
      expect(result.status).toBe("closed");
    });
  });

  describe("comment", () => {
    it("adds comment to bead", () => {
      mockExecSync.mockReturnValue("");

      client.comment("bd-a1b2", "Found the issue in auth.ts", testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        'bd comment bd-a1b2 "Found the issue in auth.ts"',
        expect.any(Object)
      );
    });
  });

  describe("depAdd", () => {
    it("adds dependency between beads", () => {
      mockExecSync.mockReturnValue("");

      client.depAdd("bd-child", "bd-parent", testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd dep add bd-child bd-parent",
        expect.any(Object)
      );
    });
  });

  describe("depRemove", () => {
    it("removes dependency between beads", () => {
      mockExecSync.mockReturnValue("");

      client.depRemove("bd-child", "bd-parent", testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd dep remove bd-child bd-parent",
        expect.any(Object)
      );
    });
  });

  describe("sync", () => {
    it("runs sync command", () => {
      mockExecSync.mockReturnValue("");

      client.sync(testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd sync",
        expect.objectContaining({ cwd: testCwd })
      );
    });
  });

  describe("init", () => {
    it("initializes beads in directory", () => {
      mockExecSync.mockReturnValue("");

      client.init(testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd init",
        expect.objectContaining({ cwd: testCwd })
      );
    });

    it("initializes in stealth mode", () => {
      mockExecSync.mockReturnValue("");

      client.init(testCwd, true);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd init --stealth",
        expect.any(Object)
      );
    });
  });

  describe("isInitialized", () => {
    it("returns true when beads is initialized", () => {
      mockExecSync.mockReturnValue("[]");

      const result = client.isInitialized(testCwd);

      expect(result).toBe(true);
    });

    it("returns false when beads is not initialized", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Not a beads directory");
      });

      const result = client.isInitialized(testCwd);

      expect(result).toBe(false);
    });
  });

  describe("error handling", () => {
    it("wraps command errors with context", () => {
      mockExecSync.mockImplementation(() => {
        const error = new Error("Command failed") as Error & { stderr: string };
        error.stderr = "bd: error: invalid option";
        throw error;
      });

      expect(() => client.ready(testCwd)).toThrow(
        /Beads command failed: bd ready/
      );
    });
  });

  // ============================================================
  // Configuration Tests
  // ============================================================

  describe("configSet", () => {
    it("sets a config value", () => {
      mockExecSync.mockReturnValue("");

      client.configSet("sync.branch", "beads-sync", testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd config set sync.branch beads-sync",
        expect.objectContaining({ cwd: testCwd })
      );
    });
  });

  describe("configGet", () => {
    it("returns config value when set", () => {
      mockExecSync.mockReturnValue("beads-sync");

      const result = client.configGet("sync.branch", testCwd);

      expect(result).toBe("beads-sync");
      expect(mockExecSync).toHaveBeenCalledWith(
        "bd config get sync.branch",
        expect.objectContaining({ cwd: testCwd })
      );
    });

    it("returns null when config not set", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("config key not found");
      });

      const result = client.configGet("nonexistent.key", testCwd);

      expect(result).toBeNull();
    });
  });

  // ============================================================
  // Daemon Management Tests
  // ============================================================

  describe("daemonStart", () => {
    it("starts daemon without options", () => {
      mockExecSync.mockReturnValue("");

      client.daemonStart(testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd daemon start",
        expect.objectContaining({ cwd: testCwd })
      );
    });

    it("starts daemon with auto-commit", () => {
      mockExecSync.mockReturnValue("");

      client.daemonStart(testCwd, { autoCommit: true });

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd daemon start --auto-commit",
        expect.objectContaining({ cwd: testCwd })
      );
    });
  });

  describe("daemonStop", () => {
    it("stops daemon", () => {
      mockExecSync.mockReturnValue("");

      client.daemonStop(testCwd);

      expect(mockExecSync).toHaveBeenCalledWith(
        "bd daemon stop",
        expect.objectContaining({ cwd: testCwd })
      );
    });

    it("ignores errors when daemon not running", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("daemon not running");
      });

      // Should not throw
      expect(() => client.daemonStop(testCwd)).not.toThrow();
    });
  });

  describe("daemonStatus", () => {
    it("returns running status with PID", () => {
      mockExecSync.mockReturnValue("✓ running (PID 12345, v0.49.3)");

      const result = client.daemonStatus(testCwd);

      expect(result.running).toBe(true);
      expect(result.pid).toBe(12345);
    });

    it("returns not running when stopped", () => {
      mockExecSync.mockReturnValue("✗ stopped");

      const result = client.daemonStatus(testCwd);

      expect(result.running).toBe(false);
      expect(result.pid).toBeUndefined();
    });

    it("returns not running on error", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("command failed");
      });

      const result = client.daemonStatus(testCwd);

      expect(result.running).toBe(false);
    });
  });

  describe("isDaemonRunning", () => {
    it("returns true when daemon running", () => {
      mockExecSync.mockReturnValue("✓ running (PID 12345)");

      expect(client.isDaemonRunning(testCwd)).toBe(true);
    });

    it("returns false when daemon stopped", () => {
      mockExecSync.mockReturnValue("✗ stopped");

      expect(client.isDaemonRunning(testCwd)).toBe(false);
    });
  });

  describe("ensureDaemonWithSyncBranch", () => {
    it("configures sync branch and starts daemon when not running", () => {
      // First call: configGet returns null (not set)
      // Second call: daemonStatus returns stopped
      // Then: configSet, daemonStart
      let callCount = 0;
      mockExecSync.mockImplementation((cmd: string) => {
        callCount++;
        if (cmd.includes("config get")) {
          throw new Error("not set");
        }
        if (cmd.includes("daemon status")) {
          return "✗ stopped";
        }
        return "";
      });

      client.ensureDaemonWithSyncBranch(testCwd, "beads-sync");

      // Should have called configSet and daemonStart
      expect(mockExecSync).toHaveBeenCalledWith(
        "bd config set sync.branch beads-sync",
        expect.anything()
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        "bd daemon start --auto-commit",
        expect.anything()
      );
    });

    it("skips configSet if sync branch already configured", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("config get")) {
          return "beads-sync";
        }
        if (cmd.includes("daemon status")) {
          return "✗ stopped";
        }
        return "";
      });

      client.ensureDaemonWithSyncBranch(testCwd, "beads-sync");

      // Should NOT have called configSet
      expect(mockExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining("config set"),
        expect.anything()
      );
    });

    it("skips daemonStart if already running", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("config get")) {
          return "beads-sync";
        }
        if (cmd.includes("daemon status")) {
          return "✓ running (PID 12345)";
        }
        return "";
      });

      client.ensureDaemonWithSyncBranch(testCwd, "beads-sync");

      // Should NOT have called daemonStart
      expect(mockExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining("daemon start"),
        expect.anything()
      );
    });
  });
});
