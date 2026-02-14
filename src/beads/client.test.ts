/**
 * Tests for Beads CLI wrapper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { BeadsClient } from "./client.js";
import type { Bead, RawBead } from "./types.js";

// Mock child_process
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

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

  // Sample raw bead (as returned by bd CLI) for testing
  const sampleRawBead: RawBead = {
    id: "bd-a1b2",
    title: "Implement auth",
    description: "Add JWT authentication",
    issue_type: "task", // CLI returns issue_type, not type
    status: "open",
    priority: 1,
    labels: ["backend"],
    dependencies: [],
    created_at: "2024-01-15T10:00:00Z",
    updated_at: "2024-01-15T10:00:00Z",
  };

  // Expected normalized bead
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
      mockExecFileSync.mockReturnValue(JSON.stringify([sampleRawBead]));

      const result = client.ready(testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["ready", "--json"],
        expect.objectContaining({ cwd: testCwd })
      );
      expect(result).toEqual([sampleBead]);
    });

    it("passes type filter", () => {
      mockExecFileSync.mockReturnValue("[]");

      client.ready(testCwd, { type: "task" });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["ready", "--type", "task", "--json"],
        expect.any(Object)
      );
    });

    it("passes priority filters", () => {
      mockExecFileSync.mockReturnValue("[]");

      client.ready(testCwd, { priorityMin: 0, priorityMax: 1 });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["ready", "--priority-min", "0", "--priority-max", "1", "--json"],
        expect.any(Object)
      );
    });

    it("passes label-none filter", () => {
      mockExecFileSync.mockReturnValue("[]");

      client.ready(testCwd, { labelNone: ["planning", "blocked"] });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["ready", "--label-none", "planning,blocked", "--json"],
        expect.any(Object)
      );
    });

    it("passes label-all filter", () => {
      mockExecFileSync.mockReturnValue("[]");

      client.ready(testCwd, { labelAll: ["whs:step"] });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["ready", "--label", "whs:step", "--json"],
        expect.any(Object)
      );
    });

    it("passes label-any filter", () => {
      mockExecFileSync.mockReturnValue("[]");

      client.ready(testCwd, { labelAny: ["urgent", "critical"] });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["ready", "--label-any", "urgent,critical", "--json"],
        expect.any(Object)
      );
    });

    it("passes all label filters together", () => {
      mockExecFileSync.mockReturnValue("[]");

      client.ready(testCwd, {
        type: "task",
        labelAll: ["whs:step"],
        labelNone: ["whs:question"],
      });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["ready", "--type", "task", "--label", "whs:step", "--label-none", "whs:question", "--json"],
        expect.any(Object)
      );
    });

    it("returns empty array when no tasks ready", () => {
      mockExecFileSync.mockReturnValue("[]");

      const result = client.ready(testCwd);

      expect(result).toEqual([]);
    });
  });

  describe("show", () => {
    it("returns bead by id", () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([sampleRawBead]));

      const result = client.show("bd-a1b2", testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["show", "bd-a1b2", "--json"],
        expect.objectContaining({ cwd: testCwd })
      );
      expect(result).toEqual(sampleBead);
    });

    it("throws on invalid id", () => {
      mockExecFileSync.mockImplementation(() => {
        const error = new Error("Command failed") as Error & { stderr: string };
        error.stderr = "Error: bead not found: bd-invalid";
        throw error;
      });

      expect(() => client.show("bd-invalid", testCwd)).toThrow("Beads command failed");
    });
  });

  describe("list", () => {
    it("lists all beads without filters", () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([sampleRawBead]));

      const result = client.list(testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["list", "--json"],
        expect.any(Object)
      );
      expect(result).toEqual([sampleBead]);
    });

    it("passes status filter", () => {
      mockExecFileSync.mockReturnValue("[]");

      client.list(testCwd, { status: "open" });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["list", "--status", "open", "--json"],
        expect.any(Object)
      );
    });

    it("passes parent filter", () => {
      mockExecFileSync.mockReturnValue("[]");

      client.list(testCwd, { parent: "bd-epic1" });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["list", "--parent", "bd-epic1", "--json"],
        expect.any(Object)
      );
    });

    it("passes multiple label filters", () => {
      mockExecFileSync.mockReturnValue("[]");

      client.list(testCwd, {
        labelAny: ["urgent", "critical"],
        labelAll: ["backend"],
        labelNone: ["wontfix"],
      });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["list", "--label-any", "urgent,critical", "--label", "backend", "--label-none", "wontfix", "--json"],
        expect.any(Object)
      );
    });
  });

  describe("create", () => {
    it("creates bead with title only", () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(sampleRawBead));

      const result = client.create("Implement auth", testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["create", "Implement auth", "--json"],
        expect.any(Object)
      );
      expect(result).toEqual(sampleBead);
    });

    it("creates bead with all options", () => {
      const beadWithLabels = { ...sampleRawBead, labels: ["backend", "urgent"] };
      // First call is create, second call is show (to fetch labels)
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify(sampleRawBead))
        .mockReturnValueOnce(JSON.stringify([beadWithLabels]));

      const result = client.create("Implement auth", testCwd, {
        type: "task",
        priority: 1,
        parent: "bd-epic1",
        status: "open",
        labels: ["backend", "urgent"],
        description: "Add JWT authentication",
      });

      // create call: description is passed via stdin (--body-file -)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["create", "Implement auth", "-t", "task", "-p", "1", "--parent", "bd-epic1", "--label", "backend", "--label", "urgent", "--body-file", "-", "--json"],
        expect.objectContaining({
          cwd: testCwd,
          input: "Add JWT authentication",
        })
      );
      // When labels are provided, we fetch the full bead to get labels in the response
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["show", sampleRawBead.id, "--json"],
        expect.any(Object)
      );
      expect(result.labels).toEqual(["backend", "urgent"]);
    });

    it("creates bead with non-open status by calling update after create", () => {
      const createdRawBead = { ...sampleRawBead, status: "open" };
      const updatedRawBead = { ...sampleRawBead, status: "blocked" };

      // First call returns created bead (single object), second call returns updated bead (as array per bd update behavior)
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify(createdRawBead))
        .mockReturnValueOnce(JSON.stringify([updatedRawBead]));

      const result = client.create("Blocked task", testCwd, {
        status: "blocked",
      });

      // Should call create first
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["create", "Blocked task", "--json"],
        expect.any(Object)
      );

      // Then call update to set status
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["update", "bd-a1b2", "--status", "blocked", "--json"],
        expect.any(Object)
      );

      expect(result.status).toBe("blocked");
    });

    it("handles quotes in title without escaping (execFileSync handles it)", () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(sampleRawBead));

      client.create('Fix "critical" bug', testCwd);

      // execFileSync passes args as array, no shell escaping needed
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ['create', 'Fix "critical" bug', "--json"],
        expect.any(Object)
      );
    });
  });

  describe("update", () => {
    it("updates bead with new status", () => {
      const updatedBead = { ...sampleBead, status: "in_progress" as const };
      mockExecFileSync.mockReturnValue(JSON.stringify([updatedBead]));

      const result = client.update("bd-a1b2", testCwd, { status: "in_progress" });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["update", "bd-a1b2", "--status", "in_progress", "--json"],
        expect.any(Object)
      );
      expect(result.status).toBe("in_progress");
    });

    it("adds and removes labels", () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([sampleRawBead]));

      client.update("bd-a1b2", testCwd, {
        labelAdd: ["needs-review"],
        labelRemove: ["wip"],
      });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["update", "bd-a1b2", "--add-label", "needs-review", "--remove-label", "wip", "--json"],
        expect.any(Object)
      );
    });

    it("passes description via stdin with --body-file -", () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([sampleRawBead]));

      client.update("bd-a1b2", testCwd, {
        description: "Updated description\nwith newlines\nand `backticks`",
      });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["update", "bd-a1b2", "--body-file", "-", "--json"],
        expect.objectContaining({
          input: "Updated description\nwith newlines\nand `backticks`",
        })
      );
    });
  });

  describe("close", () => {
    it("closes bead with reason", () => {
      const closedRawBead = { ...sampleRawBead, status: "closed" };
      mockExecFileSync.mockReturnValue(JSON.stringify([closedRawBead]));

      const result = client.close("bd-a1b2", "PR #47 merged", testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["close", "bd-a1b2", "--reason", "PR #47 merged", "--json"],
        expect.any(Object)
      );
      expect(result.status).toBe("closed");
    });
  });

  describe("comment", () => {
    it("adds comment to bead", () => {
      mockExecFileSync.mockReturnValue("");

      client.comment("bd-a1b2", "Found the issue in auth.ts", testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["comments", "add", "bd-a1b2", "Found the issue in auth.ts"],
        expect.any(Object)
      );
    });
  });

  describe("depAdd", () => {
    it("adds dependency between beads", () => {
      mockExecFileSync.mockReturnValue("");

      client.depAdd("bd-child", "bd-parent", testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["dep", "add", "bd-child", "bd-parent"],
        expect.any(Object)
      );
    });
  });

  describe("depRemove", () => {
    it("removes dependency between beads", () => {
      mockExecFileSync.mockReturnValue("");

      client.depRemove("bd-child", "bd-parent", testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["dep", "remove", "bd-child", "bd-parent"],
        expect.any(Object)
      );
    });
  });

  describe("sync", () => {
    it("runs sync command", () => {
      mockExecFileSync.mockReturnValue("");

      client.sync(testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["sync"],
        expect.objectContaining({ cwd: testCwd })
      );
    });
  });

  describe("init", () => {
    it("initializes beads in directory", () => {
      mockExecFileSync.mockReturnValue("");

      client.init(testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["init"],
        expect.objectContaining({ cwd: testCwd })
      );
    });

    it("initializes in stealth mode", () => {
      mockExecFileSync.mockReturnValue("");

      client.init(testCwd, { stealth: true });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["init", "--stealth"],
        expect.any(Object)
      );
    });

    it("initializes with custom prefix", () => {
      mockExecFileSync.mockReturnValue("");

      client.init(testCwd, { prefix: "myproj" });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["init", "-p", "myproj"],
        expect.any(Object)
      );
    });

    it("initializes with stealth and prefix", () => {
      mockExecFileSync.mockReturnValue("");

      client.init(testCwd, { stealth: true, prefix: "myproj" });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["init", "--stealth", "-p", "myproj"],
        expect.any(Object)
      );
    });
  });

  describe("setPrefix", () => {
    it("sets the issue prefix via config", () => {
      mockExecFileSync.mockReturnValue("");

      client.setPrefix("myproj", testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["config", "set", "issue_prefix", "myproj"],
        expect.objectContaining({ cwd: testCwd })
      );
    });
  });

  describe("getPrefix", () => {
    it("returns the current issue prefix", () => {
      mockExecFileSync.mockReturnValue("myproj");

      const result = client.getPrefix(testCwd);

      expect(result).toBe("myproj");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["config", "get", "issue_prefix"],
        expect.objectContaining({ cwd: testCwd })
      );
    });

    it("returns null if prefix not set", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("config key not found");
      });

      const result = client.getPrefix(testCwd);

      expect(result).toBeNull();
    });
  });

  describe("isInitialized", () => {
    it("returns true when beads is initialized", () => {
      mockExecFileSync.mockReturnValue("[]");

      const result = client.isInitialized(testCwd);

      expect(result).toBe(true);
    });

    it("returns false when beads is not initialized", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Not a beads directory");
      });

      const result = client.isInitialized(testCwd);

      expect(result).toBe(false);
    });
  });

  describe("error handling", () => {
    it("wraps command errors with context", () => {
      mockExecFileSync.mockImplementation(() => {
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
      mockExecFileSync.mockReturnValue("");

      client.configSet("sync.branch", "beads-sync", testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["config", "set", "sync.branch", "beads-sync"],
        expect.objectContaining({ cwd: testCwd })
      );
    });
  });

  describe("configGet", () => {
    it("returns config value when set", () => {
      mockExecFileSync.mockReturnValue("beads-sync");

      const result = client.configGet("sync.branch", testCwd);

      expect(result).toBe("beads-sync");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["config", "get", "sync.branch"],
        expect.objectContaining({ cwd: testCwd })
      );
    });

    it("returns null when config not set", () => {
      mockExecFileSync.mockImplementation(() => {
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
      mockExecFileSync.mockReturnValue("");

      client.daemonStart(testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["daemon", "start"],
        expect.objectContaining({ cwd: testCwd })
      );
    });

    it("starts daemon with auto-commit", () => {
      mockExecFileSync.mockReturnValue("");

      client.daemonStart(testCwd, { autoCommit: true });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["daemon", "start", "--auto-commit"],
        expect.objectContaining({ cwd: testCwd })
      );
    });
  });

  describe("daemonStop", () => {
    it("stops daemon", () => {
      mockExecFileSync.mockReturnValue("");

      client.daemonStop(testCwd);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["daemon", "stop"],
        expect.objectContaining({ cwd: testCwd })
      );
    });

    it("ignores errors when daemon not running", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("daemon not running");
      });

      // Should not throw
      expect(() => client.daemonStop(testCwd)).not.toThrow();
    });
  });

  describe("daemonStatus", () => {
    it("returns running status with PID", () => {
      mockExecFileSync.mockReturnValue("✓ running (PID 12345, v0.49.3)");

      const result = client.daemonStatus(testCwd);

      expect(result.running).toBe(true);
      expect(result.pid).toBe(12345);
    });

    it("returns not running when stopped", () => {
      mockExecFileSync.mockReturnValue("✗ stopped");

      const result = client.daemonStatus(testCwd);

      expect(result.running).toBe(false);
      expect(result.pid).toBeUndefined();
    });

    it("returns not running on error", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("command failed");
      });

      const result = client.daemonStatus(testCwd);

      expect(result.running).toBe(false);
    });
  });

  describe("isDaemonRunning", () => {
    it("returns true when daemon running", () => {
      mockExecFileSync.mockReturnValue("✓ running (PID 12345)");

      expect(client.isDaemonRunning(testCwd)).toBe(true);
    });

    it("returns false when daemon stopped", () => {
      mockExecFileSync.mockReturnValue("✗ stopped");

      expect(client.isDaemonRunning(testCwd)).toBe(false);
    });
  });

  describe("ensureDaemonWithSyncBranch", () => {
    it("configures sync branch and starts daemon when not running", () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
        const argsArr = args as string[];
        if (argsArr[0] === "config" && argsArr[1] === "get") {
          throw new Error("not set");
        }
        if (argsArr[0] === "daemon" && argsArr[1] === "status") {
          return "✗ stopped";
        }
        return "";
      });

      client.ensureDaemonWithSyncBranch(testCwd, "beads-sync");

      // Should have called configSet and daemonStart
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["config", "set", "sync.branch", "beads-sync"],
        expect.anything()
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bd",
        ["daemon", "start", "--auto-commit"],
        expect.anything()
      );
    });

    it("skips configSet if sync branch already configured", () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
        const argsArr = args as string[];
        if (argsArr[0] === "config" && argsArr[1] === "get") {
          return "beads-sync";
        }
        if (argsArr[0] === "daemon" && argsArr[1] === "status") {
          return "✗ stopped";
        }
        return "";
      });

      client.ensureDaemonWithSyncBranch(testCwd, "beads-sync");

      // Should NOT have called configSet
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        "bd",
        expect.arrayContaining(["config", "set"]),
        expect.anything()
      );
    });

    it("skips daemonStart if already running", () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
        const argsArr = args as string[];
        if (argsArr[0] === "config" && argsArr[1] === "get") {
          return "beads-sync";
        }
        if (argsArr[0] === "daemon" && argsArr[1] === "status") {
          return "✓ running (PID 12345)";
        }
        return "";
      });

      client.ensureDaemonWithSyncBranch(testCwd, "beads-sync");

      // Should NOT have called daemonStart
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        "bd",
        expect.arrayContaining(["daemon", "start"]),
        expect.anything()
      );
    });
  });
});
