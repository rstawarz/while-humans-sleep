import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./beads/index.js", () => ({
  beads: {
    daemonStatus: vi.fn(),
    list: vi.fn(),
    listComments: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("./config.js", () => ({
  expandPath: vi.fn((p: string) => p.replace("~", "/home/user")),
  loadConfig: vi.fn(),
  getConfigDir: vi.fn(() => "/tmp/test-whs"),
  findConfigDir: vi.fn(() => "/tmp/test-whs"),
  loadWhsEnv: vi.fn(() => ({})),
}));

vi.mock("./workflow.js", () => ({
  getErroredWorkflows: vi.fn(),
  getStepsPendingCI: vi.fn(),
  getSourceBeadInfo: vi.fn(),
}));

vi.mock("./worktree.js", () => ({
  listWorktrees: vi.fn(),
}));

vi.mock("./state.js", () => ({
  loadState: vi.fn(),
  getLockInfo: vi.fn(),
  getStatePath: vi.fn(() => "/tmp/test-whs/state.json"),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { beads } from "./beads/index.js";
import { getErroredWorkflows, getStepsPendingCI, getSourceBeadInfo } from "./workflow.js";
import { listWorktrees } from "./worktree.js";
import { loadState, getLockInfo } from "./state.js";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import type { Config } from "./types.js";
import { loadWhsEnv } from "./config.js";
import {
  checkClaudeAuth,
  checkBeadsDaemons,
  checkDaemonErrors,
  checkErroredWorkflows,
  checkBlockedWorkflows,
  checkCIPendingPRs,
  checkOrphanedWorktrees,
  checkStateSanity,
  formatDoctorResults,
  runDoctorChecks,
} from "./doctor.js";

const mockConfig: Config = {
  projects: [
    {
      name: "argyn",
      repoPath: "~/work/argyn",
      baseBranch: "main",
      agentsPath: "docs/llm/agents",
      beadsMode: "committed",
    },
    {
      name: "bridget_ai",
      repoPath: "~/work/bridget_ai",
      baseBranch: "main",
      agentsPath: "docs/llm/agents",
      beadsMode: "committed",
    },
  ],
  orchestratorPath: "~/work/whs-orchestrator",
  concurrency: { maxTotal: 4, maxPerProject: 2 },
  notifier: "cli",
  runnerType: "cli",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkClaudeAuth", () => {
  it("passes for CLI runner when claude responds OK", () => {
    vi.mocked(execSync)
      .mockReturnValueOnce("/usr/local/bin/claude")  // which claude
      .mockReturnValueOnce("OK");                     // claude --print

    const result = checkClaudeAuth(mockConfig);

    expect(result.status).toBe("pass");
    expect(result.message).toContain("CLI");
    expect(result.message).toContain("authenticated");
  });

  it("fails for CLI runner when claude not in PATH", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not found");
    });

    const result = checkClaudeAuth(mockConfig);

    expect(result.status).toBe("fail");
    expect(result.message).toContain("not found in PATH");
  });

  it("fails for CLI runner on auth error", () => {
    vi.mocked(execSync)
      .mockReturnValueOnce("/usr/local/bin/claude")  // which claude
      .mockImplementationOnce(() => {                  // claude --print
        throw new Error("unauthorized: token expired");
      });

    const result = checkClaudeAuth(mockConfig);

    expect(result.status).toBe("fail");
    expect(result.message).toContain("authentication failed");
  });

  it("passes for SDK runner when API key is set", () => {
    vi.mocked(loadWhsEnv).mockReturnValue({
      ANTHROPIC_API_KEY: "sk-ant-test123",
    });

    const sdkConfig = { ...mockConfig, runnerType: "sdk" as const };
    const result = checkClaudeAuth(sdkConfig);

    expect(result.status).toBe("pass");
    expect(result.message).toContain("SDK");
    expect(result.message).toContain("API key set");
  });

  it("fails for SDK runner when no API key", () => {
    vi.mocked(loadWhsEnv).mockReturnValue({});

    const sdkConfig = { ...mockConfig, runnerType: "sdk" as const };
    const result = checkClaudeAuth(sdkConfig);

    expect(result.status).toBe("fail");
    expect(result.message).toContain("no API key");
  });
});

describe("checkBeadsDaemons", () => {
  it("passes when all daemons running", () => {
    vi.mocked(beads.daemonStatus).mockReturnValue({ running: true, pid: 123 });

    const result = checkBeadsDaemons(mockConfig);

    expect(result.status).toBe("pass");
    expect(result.message).toBe("all running");
  });

  it("fails when some daemons not running", () => {
    vi.mocked(beads.daemonStatus)
      .mockReturnValueOnce({ running: true, pid: 123 })  // argyn
      .mockReturnValueOnce({ running: false })            // bridget_ai
      .mockReturnValueOnce({ running: true, pid: 456 }); // orchestrator

    const result = checkBeadsDaemons(mockConfig);

    expect(result.status).toBe("fail");
    expect(result.message).toContain("1 not running");
    expect(result.details).toContain("bridget_ai: not running");
  });

  it("includes orchestrator in check", () => {
    vi.mocked(beads.daemonStatus)
      .mockReturnValueOnce({ running: true, pid: 123 })  // argyn
      .mockReturnValueOnce({ running: true, pid: 456 })  // bridget_ai
      .mockReturnValueOnce({ running: false });           // orchestrator

    const result = checkBeadsDaemons(mockConfig);

    expect(result.status).toBe("fail");
    expect(result.details).toContain("orchestrator: not running");
  });
});

describe("checkDaemonErrors", () => {
  it("passes when no daemon-error files exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = checkDaemonErrors(mockConfig);

    expect(result.status).toBe("pass");
    expect(result.message).toBe("no errors");
  });

  it("fails when daemon-error files exist", () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      return String(path).includes("argyn");
    });
    vi.mocked(readFileSync).mockReturnValue("Daemon crashed: out of memory");

    const result = checkDaemonErrors(mockConfig);

    expect(result.status).toBe("fail");
    expect(result.message).toContain("1 daemon error");
    expect(result.details?.[0]).toContain("argyn");
    expect(result.details?.[0]).toContain("out of memory");
  });
});

describe("checkErroredWorkflows", () => {
  it("passes when no errored workflows", () => {
    vi.mocked(getErroredWorkflows).mockReturnValue([]);

    const result = checkErroredWorkflows();

    expect(result.status).toBe("pass");
  });

  it("warns when errored workflows exist", () => {
    vi.mocked(getErroredWorkflows).mockReturnValue([
      {
        epicId: "orc-xyz",
        errorType: "auth",
        reason: "auth failed",
        sourceProject: "argyn",
        sourceBeadId: "bd-a3f8",
      },
    ]);

    const result = checkErroredWorkflows();

    expect(result.status).toBe("warn");
    expect(result.message).toContain("1 errored");
    expect(result.details?.[0]).toContain("orc-xyz");
    expect(result.details?.[0]).toContain("whs retry");
  });
});

describe("checkBlockedWorkflows", () => {
  it("passes when no blocked workflows", () => {
    vi.mocked(beads.list).mockReturnValue([]);

    const result = checkBlockedWorkflows(mockConfig);

    expect(result.status).toBe("pass");
  });

  it("warns when blocked workflows exist", () => {
    vi.mocked(beads.list).mockReturnValue([
      {
        id: "orc-fcc",
        title: "bridget_ai:bai-zv0.1 - Feature",
        status: "blocked",
        type: "epic",
        priority: 2,
        labels: ["blocked:human"],
        description: "",
        dependencies: [],
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ]);
    vi.mocked(getSourceBeadInfo).mockReturnValue({
      project: "bridget_ai",
      beadId: "bai-zv0.1",
    });
    vi.mocked(beads.listComments).mockReturnValue([
      { id: 1, issue_id: "orc-fcc", author: "whs", text: "Blocked: Agent failed to produce a valid handoff.", created_at: "2025-01-01T00:00:00Z" },
    ]);

    const result = checkBlockedWorkflows(mockConfig);

    expect(result.status).toBe("warn");
    expect(result.message).toContain("1 blocked");
    expect(result.details?.[0]).toContain("bridget_ai/bai-zv0.1");
    expect(result.details?.[0]).toContain("Agent failed to produce a valid handoff");
  });

  it("filters out closed workflows", () => {
    vi.mocked(beads.list).mockReturnValue([
      {
        id: "orc-old",
        title: "closed workflow",
        status: "closed",
        type: "epic",
        priority: 2,
        labels: ["blocked:human"],
        description: "",
        dependencies: [],
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ]);

    const result = checkBlockedWorkflows(mockConfig);

    expect(result.status).toBe("pass");
  });
});

describe("checkCIPendingPRs", () => {
  it("passes when no steps pending CI", () => {
    vi.mocked(getStepsPendingCI).mockReturnValue([]);

    const result = checkCIPendingPRs(mockConfig);

    expect(result.status).toBe("pass");
    expect(result.message).toBe("none pending");
  });

  it("warns on merge conflicts", () => {
    vi.mocked(getStepsPendingCI).mockReturnValue([
      { id: "step-1", epicId: "orc-1", prNumber: 46, retryCount: 0, agent: "quality_review", project: "argyn", sourceBeadId: "bd-123", title: "Test task" },
    ]);
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify({ state: "OPEN", mergeable: "CONFLICTING", checks: [] })
    );

    const result = checkCIPendingPRs(mockConfig);

    expect(result.status).toBe("warn");
    expect(result.details?.[0]).toContain("PR #46: merge conflicts");
  });

  it("passes with passing checks", () => {
    vi.mocked(getStepsPendingCI).mockReturnValue([
      { id: "step-1", epicId: "orc-1", prNumber: 46, retryCount: 0, agent: "quality_review", project: "argyn", sourceBeadId: "bd-123", title: "Test task" },
    ]);
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", checks: ["SUCCESS"] })
    );

    const result = checkCIPendingPRs(mockConfig);

    expect(result.status).toBe("pass");
    expect(result.message).toContain("1 passed");
  });
});

describe("checkOrphanedWorktrees", () => {
  it("passes when all worktrees have active workflows", () => {
    vi.mocked(beads.list).mockReturnValue([
      {
        id: "orc-1",
        title: "argyn:bd-123 - Feature",
        status: "open",
        type: "epic",
        priority: 2,
        labels: ["whs:workflow", "source:argyn", "sourceId:bd-123"],
        description: "",
        dependencies: [],
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ]);
    vi.mocked(getSourceBeadInfo).mockReturnValue({
      project: "argyn",
      beadId: "bd-123",
    });
    vi.mocked(listWorktrees)
      .mockReturnValueOnce([
        { branch: "bd-123", path: "/path/to/wt", kind: "worktree", isMain: false, isCurrent: false },
      ])
      .mockReturnValueOnce([]);

    const result = checkOrphanedWorktrees(mockConfig);

    expect(result.status).toBe("pass");
    expect(result.message).toContain("1 active");
  });

  it("shows open PR for unmanaged worktree", () => {
    vi.mocked(beads.list).mockReturnValue([]); // no active epics
    vi.mocked(listWorktrees)
      .mockReturnValueOnce([
        { branch: "main", path: "/path/to/main", kind: "worktree", isMain: true, isCurrent: true },
        { branch: "old-branch", path: "/path/to/old", kind: "worktree", isMain: false, isCurrent: false },
      ])
      .mockReturnValueOnce([]);
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify([{ number: 48, headRefName: "old-branch", state: "OPEN" }])
    );

    const result = checkOrphanedWorktrees(mockConfig);

    expect(result.status).toBe("pass");
    expect(result.message).toContain("1 with open PR");
    expect(result.details?.[0]).toContain("argyn/old-branch");
    expect(result.details?.[0]).toContain("PR #48 open");
    expect(result.details?.[0]).toContain("needs review/merge");
  });

  it("shows merged PR as safe to remove", () => {
    vi.mocked(beads.list).mockReturnValue([]);
    vi.mocked(listWorktrees)
      .mockReturnValueOnce([
        { branch: "main", path: "/path/to/main", kind: "worktree", isMain: true, isCurrent: true },
        { branch: "done-branch", path: "/path/to/done", kind: "worktree", isMain: false, isCurrent: false },
      ])
      .mockReturnValueOnce([]);
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify([{ number: 45, headRefName: "done-branch", state: "MERGED" }])
    );

    const result = checkOrphanedWorktrees(mockConfig);

    expect(result.status).toBe("pass");
    expect(result.message).toContain("1 safe to remove");
    expect(result.details?.[0]).toContain("PR #45 merged");
  });

  it("shows no-PR worktree as unknown", () => {
    vi.mocked(beads.list).mockReturnValue([]);
    vi.mocked(listWorktrees)
      .mockReturnValueOnce([
        { branch: "main", path: "/path/to/main", kind: "worktree", isMain: true, isCurrent: true },
        { branch: "mystery", path: "/path/to/mystery", kind: "worktree", isMain: false, isCurrent: false },
      ])
      .mockReturnValueOnce([]);
    vi.mocked(execSync).mockReturnValue(JSON.stringify([]));

    const result = checkOrphanedWorktrees(mockConfig);

    expect(result.status).toBe("pass");
    expect(result.message).toContain("1 with no PR");
    expect(result.details?.[0]).toContain("argyn/mystery: no PR");
  });

  it("excludes beads-sync worktrees", () => {
    vi.mocked(beads.list).mockReturnValue([]); // no active epics
    vi.mocked(listWorktrees)
      .mockReturnValueOnce([
        { branch: "main", path: "/work/argyn", kind: "worktree", isMain: true, isCurrent: true },
        { branch: "beads-sync", path: "/work/argyn/.git/beads-worktrees/beads-sync", kind: "worktree", isMain: false, isCurrent: false },
      ])
      .mockReturnValueOnce([
        { branch: "main", path: "/work/bridget_ai", kind: "worktree", isMain: true, isCurrent: true },
        { branch: "beads-sync", path: "/work/bridget_ai/.git/beads-worktrees/beads-sync", kind: "worktree", isMain: false, isCurrent: false },
      ]);

    const result = checkOrphanedWorktrees(mockConfig);

    expect(result.status).toBe("pass");
  });
});

describe("checkStateSanity", () => {
  it("passes when state is clean", () => {
    vi.mocked(loadState).mockReturnValue({
      activeWork: new Map(),
      paused: false,
      lastUpdated: new Date(),
    });
    vi.mocked(getLockInfo).mockReturnValue(null);

    const result = checkStateSanity();

    expect(result.status).toBe("pass");
    expect(result.message).toBe("clean");
  });

  it("warns when paused", () => {
    vi.mocked(loadState).mockReturnValue({
      activeWork: new Map(),
      paused: true,
      lastUpdated: new Date(),
    });
    vi.mocked(getLockInfo).mockReturnValue(null);

    const result = checkStateSanity();

    expect(result.status).toBe("warn");
    expect(result.message).toContain("paused");
  });

  it("warns on stale activeWork with no dispatcher", () => {
    const activeWork = new Map();
    activeWork.set("step-1", { workItem: { id: "step-1" } });
    vi.mocked(loadState).mockReturnValue({
      activeWork,
      paused: false,
      lastUpdated: new Date(),
    });
    vi.mocked(getLockInfo).mockReturnValue(null);

    const result = checkStateSanity();

    expect(result.status).toBe("warn");
    expect(result.message).toContain("stale");
  });
});

describe("formatDoctorResults", () => {
  it("formats all-pass results", () => {
    const output = formatDoctorResults([
      { name: "Beads daemons", status: "pass", message: "all running" },
      { name: "State", status: "pass", message: "clean" },
    ]);

    expect(output).toContain("🩺 WHS Doctor");
    expect(output).toContain("✓ Beads daemons: all running");
    expect(output).toContain("all checks passed");
  });

  it("formats results with warnings and errors", () => {
    const output = formatDoctorResults([
      { name: "Beads daemons", status: "fail", message: "1 not running", details: ["argyn: not running"] },
      { name: "State", status: "warn", message: "paused", details: ["paused from previous session"] },
    ]);

    expect(output).toContain("✗ Beads daemons: 1 not running");
    expect(output).toContain("⚠ State: paused");
    expect(output).toContain("1 warning");
    expect(output).toContain("1 error");
  });
});

describe("runDoctorChecks", () => {
  it("runs all checks and returns results", async () => {
    // Set up minimal mocks for all checks to pass
    vi.mocked(execSync)
      .mockReturnValueOnce("/usr/local/bin/claude")  // which claude
      .mockReturnValueOnce("OK");                     // claude --print
    vi.mocked(beads.daemonStatus).mockReturnValue({ running: true, pid: 123 });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(getErroredWorkflows).mockReturnValue([]);
    vi.mocked(beads.list).mockReturnValue([]);
    vi.mocked(getStepsPendingCI).mockReturnValue([]);
    vi.mocked(listWorktrees).mockReturnValue([]);
    vi.mocked(loadState).mockReturnValue({
      activeWork: new Map(),
      paused: false,
      lastUpdated: new Date(),
    });
    vi.mocked(getLockInfo).mockReturnValue(null);

    const results = await runDoctorChecks(mockConfig);

    expect(results).toHaveLength(8);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });
});
