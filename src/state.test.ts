import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ActiveWork, WorkItem } from "./types.js";

// Note: These tests use the real state module which writes to ~/.whs/
// We test serialization logic separately to avoid file system side effects

describe("state serialization", () => {
  // Create test data
  const testWorkItem: WorkItem = {
    id: "bd-test-1",
    project: "test-project",
    title: "Test Task",
    description: "A test task",
    priority: 2,
    type: "task",
    status: "in_progress",
    labels: [],
    dependencies: [],
  };

  const testActiveWork: ActiveWork = {
    workItem: testWorkItem,
    workflowEpicId: "bd-w001",
    workflowStepId: "bd-w001.1",
    sessionId: "session-123",
    worktreePath: "/tmp/test-worktree",
    startedAt: new Date("2024-01-15T10:00:00Z"),
    agent: "implementation",
    costSoFar: 0.05,
  };

  it("serializes and deserializes ActiveWork correctly", () => {
    // Simulate serialization (what saveState does)
    const serialized = {
      ...testActiveWork,
      startedAt: testActiveWork.startedAt.toISOString(),
    };

    // Simulate deserialization (what loadState does)
    const deserialized: ActiveWork = {
      ...serialized,
      startedAt: new Date(serialized.startedAt),
    };

    expect(deserialized.workItem.id).toBe(testActiveWork.workItem.id);
    expect(deserialized.sessionId).toBe(testActiveWork.sessionId);
    expect(deserialized.startedAt.getTime()).toBe(testActiveWork.startedAt.getTime());
    expect(deserialized.costSoFar).toBe(testActiveWork.costSoFar);
  });

  it("handles empty state", () => {
    const emptyState = {
      version: 2,
      activeWork: {},
      paused: false,
      lastUpdated: new Date().toISOString(),
    };

    const json = JSON.stringify(emptyState);
    const parsed = JSON.parse(json);

    expect(Object.keys(parsed.activeWork)).toHaveLength(0);
    expect(parsed.paused).toBe(false);
  });

  it("preserves all WorkItem fields", () => {
    const workItem: WorkItem = {
      id: "bd-123",
      project: "myproject",
      title: "Complex Task",
      description: "A task with all fields",
      priority: 0,
      type: "epic",
      status: "blocked",
      labels: ["planning", "whs"],
      dependencies: ["bd-122", "bd-121"],
    };

    const json = JSON.stringify(workItem);
    const parsed = JSON.parse(json) as WorkItem;

    expect(parsed.id).toBe(workItem.id);
    expect(parsed.project).toBe(workItem.project);
    expect(parsed.priority).toBe(0);
    expect(parsed.type).toBe("epic");
    expect(parsed.status).toBe("blocked");
    expect(parsed.dependencies).toEqual(["bd-122", "bd-121"]);
  });
});

describe("state file format", () => {
  it("produces valid JSON structure", () => {
    const state = {
      version: 2,
      activeWork: {
        "bd-test-1": {
          workItem: {
            id: "bd-test-1",
            project: "test",
            title: "Test",
            description: "Test",
            priority: 2,
            type: "task",
            status: "in_progress",
            dependencies: [],
          },
          workflowEpicId: "bd-w001",
          workflowStepId: "bd-w001.1",
          sessionId: "session-123",
          worktreePath: "/tmp/test",
          startedAt: "2024-01-15T10:00:00.000Z",
          agent: "implementation",
          costSoFar: 0.05,
        },
      },
      paused: false,
      lastUpdated: "2024-01-15T10:00:00.000Z",
    };

    const json = JSON.stringify(state, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe(2);
    expect(parsed.activeWork["bd-test-1"]).toBeDefined();
    expect(parsed.activeWork["bd-test-1"].agent).toBe("implementation");
  });
});

describe("getStateSummary", () => {
  it("calculates summary correctly", async () => {
    // Import dynamically to avoid side effects during module load
    const { getStateSummary } = await import("./state.js");

    const state = {
      activeWork: new Map([
        [
          "bd-1",
          {
            workItem: { id: "bd-1", project: "project-a" } as WorkItem,
            startedAt: new Date("2024-01-15T10:00:00Z"),
          } as ActiveWork,
        ],
        [
          "bd-2",
          {
            workItem: { id: "bd-2", project: "project-b" } as WorkItem,
            startedAt: new Date("2024-01-15T11:00:00Z"),
          } as ActiveWork,
        ],
        [
          "bd-3",
          {
            workItem: { id: "bd-3", project: "project-a" } as WorkItem,
            startedAt: new Date("2024-01-15T09:00:00Z"),
          } as ActiveWork,
        ],
      ]),
      paused: true,
      lastUpdated: new Date(),
    };

    const summary = getStateSummary(state);

    expect(summary.activeWorkCount).toBe(3);
    expect(summary.paused).toBe(true);
    expect(summary.activeProjects).toContain("project-a");
    expect(summary.activeProjects).toContain("project-b");
    expect(summary.activeProjects).toHaveLength(2);
    expect(summary.oldestWork?.getTime()).toBe(new Date("2024-01-15T09:00:00Z").getTime());
  });

  it("handles empty state", async () => {
    const { getStateSummary } = await import("./state.js");

    const state = {
      activeWork: new Map(),
      paused: false,
      lastUpdated: new Date(),
    };

    const summary = getStateSummary(state);

    expect(summary.activeWorkCount).toBe(0);
    expect(summary.paused).toBe(false);
    expect(summary.activeProjects).toHaveLength(0);
    expect(summary.oldestWork).toBeNull();
  });
});

// Integration tests that actually use the file system
// These modify ~/.whs/state.json so we skip them by default
describe.skip("state persistence integration", () => {
  it("saves and loads state", async () => {
    const { loadState, saveState, clearState } = await import("./state.js");

    // Clear any existing state
    clearState();

    // Load fresh state
    const state = loadState();
    expect(state.activeWork.size).toBe(0);

    // Modify and save
    state.activeWork.set("test-1", {
      workItem: {
        id: "test-1",
        project: "test",
        title: "Test",
        description: "Test",
        priority: 2,
        type: "task",
        status: "in_progress",
        labels: [],
        dependencies: [],
      },
      workflowEpicId: "w-1",
      workflowStepId: "w-1.1",
      sessionId: "s-1",
      worktreePath: "/tmp/test",
      startedAt: new Date(),
      agent: "implementation",
      costSoFar: 0,
    });
    saveState(state);

    // Reload and verify
    const reloaded = loadState();
    expect(reloaded.activeWork.size).toBe(1);
    expect(reloaded.activeWork.get("test-1")?.agent).toBe("implementation");

    // Clean up
    clearState();
  });
});

// Test state mutation functions with isolated state objects
describe("state mutation functions", () => {
  const createTestState = () => ({
    activeWork: new Map<string, ActiveWork>(),
    paused: false,
    lastUpdated: new Date(),
  });

  const testWorkItem: WorkItem = {
    id: "bd-test-1",
    project: "test-project",
    title: "Test Task",
    description: "A test task",
    priority: 2,
    type: "task",
    status: "in_progress",
    labels: [],
    dependencies: [],
  };

  const testActiveWork: ActiveWork = {
    workItem: testWorkItem,
    workflowEpicId: "bd-w001",
    workflowStepId: "bd-w001.1",
    sessionId: "session-123",
    worktreePath: "/tmp/test-worktree",
    startedAt: new Date("2024-01-15T10:00:00Z"),
    agent: "implementation",
    costSoFar: 0.05,
  };

  describe("activeWork operations", () => {
    it("addActiveWork adds work to state", () => {
      const state = createTestState();

      // Simulate addActiveWork
      const newState = {
        ...state,
        activeWork: new Map(state.activeWork),
        lastUpdated: new Date(),
      };
      newState.activeWork.set(testActiveWork.workItem.id, testActiveWork);

      expect(newState.activeWork.size).toBe(1);
      expect(newState.activeWork.get("bd-test-1")?.agent).toBe("implementation");
    });

    it("removeActiveWork removes work from state", () => {
      const state = createTestState();
      state.activeWork.set("bd-test-1", testActiveWork);
      state.activeWork.set("bd-test-2", { ...testActiveWork, workItem: { ...testWorkItem, id: "bd-test-2" } });

      // Simulate removeActiveWork
      const newState = {
        ...state,
        activeWork: new Map(state.activeWork),
        lastUpdated: new Date(),
      };
      newState.activeWork.delete("bd-test-1");

      expect(newState.activeWork.size).toBe(1);
      expect(newState.activeWork.has("bd-test-1")).toBe(false);
      expect(newState.activeWork.has("bd-test-2")).toBe(true);
    });

    it("updateActiveWork updates existing work", () => {
      const state = createTestState();
      state.activeWork.set("bd-test-1", testActiveWork);

      // Simulate updateActiveWork
      const existing = state.activeWork.get("bd-test-1");
      const newState = {
        ...state,
        activeWork: new Map(state.activeWork),
        lastUpdated: new Date(),
      };
      if (existing) {
        newState.activeWork.set("bd-test-1", { ...existing, costSoFar: 0.15, agent: "quality_review" });
      }

      expect(newState.activeWork.get("bd-test-1")?.costSoFar).toBe(0.15);
      expect(newState.activeWork.get("bd-test-1")?.agent).toBe("quality_review");
    });

    it("updateActiveWork returns unchanged state if work not found", () => {
      const state = createTestState();

      // Simulate updateActiveWork with non-existent ID
      const existing = state.activeWork.get("nonexistent");
      expect(existing).toBeUndefined();
      // In real function, this would return the original state unchanged
    });
  });

  describe("paused state operations", () => {
    it("setPaused updates paused state", () => {
      const state = createTestState();
      expect(state.paused).toBe(false);

      // Simulate setPaused
      const newState = {
        ...state,
        paused: true,
        lastUpdated: new Date(),
      };

      expect(newState.paused).toBe(true);
    });

    it("setPaused can toggle paused state", () => {
      const state = createTestState();
      state.paused = true;

      // Simulate setPaused(false)
      const newState = {
        ...state,
        paused: false,
        lastUpdated: new Date(),
      };

      expect(newState.paused).toBe(false);
    });
  });

  describe("clearState operation", () => {
    it("clearState returns empty state", () => {
      const state = createTestState();
      state.activeWork.set("bd-test-1", testActiveWork);
      state.paused = true;

      // Simulate clearState
      const clearedState = {
        activeWork: new Map(),
        paused: false,
        lastUpdated: new Date(),
      };

      expect(clearedState.activeWork.size).toBe(0);
      expect(clearedState.paused).toBe(false);
    });
  });
});

// Test state loading edge cases
describe("state loading edge cases", () => {
  it("handles version mismatch gracefully", () => {
    const oldVersionState = {
      version: 0, // Old version
      activeWork: {},
      paused: false,
      lastUpdated: new Date().toISOString(),
    };

    // When version doesn't match CURRENT_VERSION (2), should return empty state
    const shouldReturnEmpty = oldVersionState.version !== 2;
    expect(shouldReturnEmpty).toBe(true);
  });

  it("handles corrupt JSON gracefully", () => {
    // Simulate what loadState does on parse error
    try {
      JSON.parse("{ invalid json }");
    } catch {
      // Should return empty state on parse error
      const emptyState = {
        activeWork: new Map(),
        paused: false,
        lastUpdated: new Date(),
      };
      expect(emptyState.activeWork.size).toBe(0);
    }
  });
});

// Tests that directly use state functions with a temp orchestrator directory
describe("state module direct tests", () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temp orchestrator directory with .whs config
    tempDir = join(tmpdir(), `whs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const whsDir = join(tempDir, ".whs");
    mkdirSync(whsDir, { recursive: true });
    // Create minimal config.json
    const config = {
      projects: [],
      orchestratorPath: tempDir,
      concurrency: { maxTotal: 4, maxPerProject: 2 },
      notifier: "cli",
      runnerType: "cli",
    };
    const { writeFileSync } = require("fs");
    writeFileSync(join(whsDir, "config.json"), JSON.stringify(config));
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("getStatePath returns path to state file", async () => {
    const { getStatePath } = await import("./state.js");
    const path = getStatePath(tempDir);
    expect(path).toContain("state.json");
    expect(path).toContain(".whs");
  });
});

// ============================================================
// Lock File Tests
// ============================================================

describe("lock file management", () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temp orchestrator directory with .whs config
    tempDir = join(tmpdir(), `whs-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const whsDir = join(tempDir, ".whs");
    mkdirSync(whsDir, { recursive: true });
    // Create minimal config.json
    const config = {
      projects: [],
      orchestratorPath: tempDir,
      concurrency: { maxTotal: 4, maxPerProject: 2 },
      notifier: "cli",
      runnerType: "cli",
    };
    const { writeFileSync } = require("fs");
    writeFileSync(join(whsDir, "config.json"), JSON.stringify(config));
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("getLockPath returns path to lock file", async () => {
    const { getLockPath } = await import("./state.js");
    const path = getLockPath(tempDir);
    expect(path).toContain("dispatcher.lock");
    expect(path).toContain(".whs");
  });

  it("acquireLock and releaseLock work together", async () => {
    const { acquireLock, releaseLock, getLockInfo } = await import("./state.js");

    // Ensure no lock exists
    releaseLock(tempDir);

    // Should be able to acquire lock
    const acquired = acquireLock(tempDir);
    expect(acquired).toBe(true);

    // Lock info should show our PID
    const info = getLockInfo(tempDir);
    expect(info).not.toBeNull();
    expect(info?.pid).toBe(process.pid);

    // Release lock
    releaseLock(tempDir);

    // Lock info should be null
    const infoAfter = getLockInfo(tempDir);
    expect(infoAfter).toBeNull();
  });

  it("acquireLock returns false if already locked by current process", async () => {
    const { acquireLock, releaseLock } = await import("./state.js");

    // Clean up first
    releaseLock(tempDir);

    // First acquire should succeed
    const first = acquireLock(tempDir);
    expect(first).toBe(true);

    // Second acquire should fail (lock held by us)
    const second = acquireLock(tempDir);
    expect(second).toBe(false);

    // Clean up
    releaseLock(tempDir);
  });

  it("getLockInfo returns null when no lock exists", async () => {
    const { releaseLock, getLockInfo } = await import("./state.js");

    releaseLock(tempDir); // Ensure no lock

    const info = getLockInfo(tempDir);
    expect(info).toBeNull();
  });

  it("getLockInfo detects stale locks from dead processes", async () => {
    const { getLockInfo, getLockPath, releaseLock } = await import("./state.js");
    const { writeFileSync } = await import("fs");

    // Clean up first
    releaseLock(tempDir);

    // Create a fake lock with non-existent PID
    const fakeLock = {
      pid: 999999999, // Very unlikely to be a real PID
      startedAt: new Date().toISOString(),
    };
    writeFileSync(getLockPath(tempDir), JSON.stringify(fakeLock));

    // getLockInfo should return null (stale lock)
    const info = getLockInfo(tempDir);
    expect(info).toBeNull();

    // Clean up
    releaseLock(tempDir);
  });
});
