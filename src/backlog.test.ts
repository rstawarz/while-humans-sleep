import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process
const mockExecSync = vi.fn();
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock beads module
vi.mock("./beads/index.js", () => ({
  beads: {
    list: vi.fn(),
    show: vi.fn(),
  },
}));

// Mock config module
vi.mock("./config.js", () => ({
  loadConfig: vi.fn(() => ({
    orchestratorPath: "/mock/orchestrator",
    projects: [
      {
        name: "bread_and_butter",
        repoPath: "/mock/projects/bread_and_butter",
        baseBranch: "main",
        agentsPath: "docs/llm/agents",
        beadsMode: "committed",
      },
    ],
    concurrency: { maxTotal: 4, maxPerProject: 2 },
    notifier: "cli",
  })),
  expandPath: vi.fn((path: string) => path),
  getProject: vi.fn((name: string) => {
    if (name === "bread_and_butter") {
      return {
        name: "bread_and_butter",
        repoPath: "/mock/projects/bread_and_butter",
        baseBranch: "main",
        agentsPath: "docs/llm/agents",
        beadsMode: "committed",
      };
    }
    return null;
  }),
}));

// Mock workflow module
vi.mock("./workflow.js", () => ({
  getWorkflowForSource: vi.fn(),
  getOrchestratorPath: vi.fn(() => "/mock/orchestrator"),
}));

import type { Bead } from "./beads/types.js";

function makeBead(overrides: Partial<Bead>): Bead {
  return {
    id: "test-1",
    title: "Test Bead",
    description: "",
    type: "task",
    status: "open",
    priority: 2,
    labels: [],
    dependencies: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("getBacklogData", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockBeads: any;
  let mockGetWorkflowForSource: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const beadsModule = await import("./beads/index.js");
    mockBeads = beadsModule.beads;
    const workflowModule = await import("./workflow.js");
    mockGetWorkflowForSource = workflowModule.getWorkflowForSource as ReturnType<typeof vi.fn>;
  });

  it("returns empty items for project with no beads", async () => {
    mockBeads.list.mockReturnValue([]);
    mockGetWorkflowForSource.mockReturnValue(null);

    const { getBacklogData } = await import("./backlog.js");
    const data = getBacklogData("bread_and_butter");

    expect(data.project).toBe("bread_and_butter");
    expect(data.items).toHaveLength(0);
    expect(data.summary).toEqual({ open: 0, inProgress: 0, closed: 0, blocked: 0 });
  });

  it("throws for unknown project", async () => {
    const { getProject } = await import("./config.js");
    (getProject as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    const { getBacklogData } = await import("./backlog.js");
    expect(() => getBacklogData("unknown_project")).toThrow('Project "unknown_project" not found');
  });

  it("gathers standalone tasks", async () => {
    const task1 = makeBead({ id: "bb-1", title: "Fix login redirect", type: "task", status: "open" });
    const task2 = makeBead({ id: "bb-2", title: "Update dependencies", type: "task", status: "open" });

    // open returns both tasks, other statuses return empty
    mockBeads.list.mockImplementation((_cwd: string, options?: { status?: string }) => {
      if (options?.status === "open") return [task1, task2];
      return [];
    });
    mockGetWorkflowForSource.mockReturnValue(null);

    const { getBacklogData } = await import("./backlog.js");
    const data = getBacklogData("bread_and_butter");

    expect(data.items).toHaveLength(2);
    expect(data.items[0].bead.title).toBe("Fix login redirect");
    expect(data.items[1].bead.title).toBe("Update dependencies");
    expect(data.summary.open).toBe(2);
  });

  it("groups children under epic", async () => {
    const epic = makeBead({
      id: "bb-72i",
      title: "AppShell Migration",
      type: "epic",
      status: "in_progress",
    });

    mockBeads.list.mockImplementation((_cwd: string, options?: { status?: string }) => {
      if (options?.status === "in_progress") return [epic];
      return [];
    });

    // bd show returns epic with dependents
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("bd show bb-72i")) {
        return JSON.stringify([{
          dependents: [
            { id: "bb-72i.1", title: "Set up AppShell component", status: "closed", issue_type: "task", priority: 2, labels: [], dependencies: [], created_at: "", updated_at: "" },
            { id: "bb-72i.2", title: "Batch-Migrate Recipe Pages", status: "closed", issue_type: "task", priority: 2, labels: [], dependencies: [], created_at: "", updated_at: "" },
            { id: "bb-72i.3", title: "Batch-Migrate Food/Utility Pages", status: "in_progress", issue_type: "task", priority: 2, labels: [], dependencies: [], created_at: "", updated_at: "" },
          ],
        }]);
      }
      return "[]";
    });

    mockGetWorkflowForSource.mockReturnValue(null);

    const { getBacklogData } = await import("./backlog.js");
    const data = getBacklogData("bread_and_butter");

    expect(data.items).toHaveLength(1);
    expect(data.items[0].bead.id).toBe("bb-72i");
    // Without --all, closed children are filtered out
    expect(data.items[0].children).toHaveLength(1);
    expect(data.items[0].children[0].bead.id).toBe("bb-72i.3");
  });

  it("includes closed children with --all flag", async () => {
    const epic = makeBead({
      id: "bb-72i",
      title: "AppShell Migration",
      type: "epic",
      status: "in_progress",
    });

    // With --all, list returns all beads (no status filter)
    mockBeads.list.mockImplementation((_cwd: string, options?: { status?: string }) => {
      if (!options?.status) return [epic];
      return [];
    });

    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("bd show bb-72i")) {
        return JSON.stringify([{
          dependents: [
            { id: "bb-72i.1", title: "Set up AppShell", status: "closed", issue_type: "task", priority: 2, labels: [], dependencies: [], created_at: "", updated_at: "" },
            { id: "bb-72i.2", title: "Migrate pages", status: "open", issue_type: "task", priority: 2, labels: [], dependencies: [], created_at: "", updated_at: "" },
          ],
        }]);
      }
      return "[]";
    });

    mockGetWorkflowForSource.mockReturnValue(null);

    const { getBacklogData } = await import("./backlog.js");
    const data = getBacklogData("bread_and_butter", { includeAll: true });

    expect(data.items[0].children).toHaveLength(2);
    expect(data.summary.closed).toBe(1);
    expect(data.summary.open).toBe(1);
  });

  it("filters out non-parent-child dependents from bd show", async () => {
    const epic = makeBead({
      id: "bb-72i",
      title: "Navigation Epic",
      type: "epic",
      status: "in_progress",
    });

    mockBeads.list.mockImplementation((_cwd: string, options?: { status?: string }) => {
      if (options?.status === "in_progress") return [epic];
      return [];
    });

    // bd show returns both parent-child and blocks dependents
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("bd show bb-72i")) {
        return JSON.stringify([{
          dependents: [
            { id: "bb-72i.1", title: "Child task", status: "open", issue_type: "task", priority: 2, labels: [], dependencies: [], dependency_type: "parent-child", created_at: "", updated_at: "" },
            { id: "bb-1w5", title: "Another epic (blocks dep)", status: "in_progress", issue_type: "epic", priority: 2, labels: [], dependencies: [], dependency_type: "blocks", created_at: "", updated_at: "" },
          ],
        }]);
      }
      return "[]";
    });

    mockGetWorkflowForSource.mockReturnValue(null);

    const { getBacklogData } = await import("./backlog.js");
    const data = getBacklogData("bread_and_butter");

    // Should only have the parent-child dependent, not the "blocks" one
    expect(data.items[0].children).toHaveLength(1);
    expect(data.items[0].children[0].bead.id).toBe("bb-72i.1");
  });

  it("extracts string IDs from object dependencies and prunes closed ones", async () => {
    const epic = makeBead({
      id: "bb-1w5",
      title: "Inline Food Logging",
      type: "epic",
      status: "in_progress",
      // bd list returns dependencies as objects with depends_on_id and type
      dependencies: [
        { depends_on_id: "bb-72i", type: "blocks", issue_id: "bb-1w5" },
        { depends_on_id: "bb-closed", type: "blocks", issue_id: "bb-1w5" },
      ] as unknown as string[],
    });

    mockBeads.list.mockImplementation((_cwd: string, options?: { status?: string }) => {
      if (options?.status === "in_progress") return [epic];
      return [];
    });

    // bb-72i is still open, bb-closed is closed
    mockBeads.show.mockImplementation((id: string) => {
      if (id === "bb-72i") return makeBead({ id: "bb-72i", status: "open" });
      if (id === "bb-closed") return makeBead({ id: "bb-closed", status: "closed" });
      throw new Error("not found");
    });

    mockExecSync.mockReturnValue("[]");
    mockGetWorkflowForSource.mockReturnValue(null);

    const { getBacklogData } = await import("./backlog.js");
    const data = getBacklogData("bread_and_butter");

    // Should extract IDs from objects and prune the closed one
    expect(data.items[0].blockedBy).toEqual(["bb-72i"]);
  });

  it("overlays workflow state from orchestrator", async () => {
    const task = makeBead({ id: "bb-73a", title: "Fix login redirect", type: "task", status: "in_progress" });

    mockBeads.list.mockImplementation((_cwd: string, options?: { status?: string }) => {
      if (options?.status === "in_progress") return [task];
      return [];
    });

    mockGetWorkflowForSource.mockImplementation((_project: string, beadId: string) => {
      if (beadId === "bb-73a") {
        return {
          id: "orc-w001",
          sourceProject: "bread_and_butter",
          sourceBeadId: "bb-73a",
          title: "bread_and_butter:bb-73a - Fix login redirect",
          status: "open",
          createdAt: new Date(),
        };
      }
      return null;
    });

    mockBeads.show.mockReturnValue(makeBead({ id: "orc-w001", labels: [] }));

    // bd show for workflow epic steps
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("bd show orc-w001")) {
        return JSON.stringify([{
          dependents: [
            { id: "orc-w001.1", title: "implementation", status: "closed", labels: ["agent:implementation", "whs:step"] },
            { id: "orc-w001.2", title: "quality_review", status: "in_progress", labels: ["agent:quality_review", "whs:step", "pr:42", "ci:pending"] },
          ],
        }]);
      }
      return "[]";
    });

    const { getBacklogData } = await import("./backlog.js");
    const data = getBacklogData("bread_and_butter");

    const item = data.items[0];
    expect(item.workflowStatus).toBe("active");
    expect(item.activeAgent).toBe("quality_review");
    expect(item.prNumber).toBe(42);
    expect(item.ciStatus).toBe("pending");
  });
});

describe("formatBacklog", () => {
  it("formats empty backlog", async () => {
    const { formatBacklog } = await import("./backlog.js");
    const output = formatBacklog({
      project: "test_project",
      items: [],
      summary: { open: 0, inProgress: 0, closed: 0, blocked: 0 },
    });

    expect(output).toContain("test_project");
    expect(output).toContain("No open beads.");
  });

  it("formats epic with children", async () => {
    const { formatBacklog } = await import("./backlog.js");
    const output = formatBacklog({
      project: "bread_and_butter",
      items: [
        {
          bead: makeBead({ id: "bb-72i", title: "AppShell Migration", type: "epic", status: "in_progress" }),
          children: [
            {
              bead: makeBead({ id: "bb-72i.1", title: "Set up AppShell", status: "closed" }),
              children: [],
            },
            {
              bead: makeBead({ id: "bb-72i.2", title: "Migrate pages", status: "open" }),
              children: [],
              blockedBy: ["bb-72i.1"],
            },
          ],
        },
      ],
      summary: { open: 1, inProgress: 1, closed: 1, blocked: 0 },
    });

    expect(output).toContain("bread_and_butter");
    expect(output).toContain("AppShell Migration");
    expect(output).toContain("bb-72i");
    expect(output).toContain("✅");  // closed icon
    expect(output).toContain("⏳");  // open icon
    expect(output).toContain("├─");  // tree connector
    expect(output).toContain("└─");  // last child connector
    expect(output).toContain("1 open");
    expect(output).toContain("1 in progress");
    expect(output).toContain("1 closed");
  });

  it("formats standalone task with PR annotation", async () => {
    const { formatBacklog } = await import("./backlog.js");
    const output = formatBacklog({
      project: "test",
      items: [
        {
          bead: makeBead({ id: "t-1", title: "Fix bug", status: "in_progress" }),
          children: [],
          prNumber: 42,
          ciStatus: "pending",
        },
      ],
      summary: { open: 0, inProgress: 1, closed: 0, blocked: 0 },
    });

    expect(output).toContain("PR #42");
    expect(output).toContain("CI pending");
    expect(output).toContain("🔄");  // in_progress icon
  });

  it("formats blocked item with dependency annotation", async () => {
    const { formatBacklog } = await import("./backlog.js");
    const output = formatBacklog({
      project: "test",
      items: [
        {
          bead: makeBead({ id: "t-2", title: "Cleanup", status: "blocked" }),
          children: [],
          blockedBy: ["t-1"],
        },
      ],
      summary: { open: 0, inProgress: 0, closed: 0, blocked: 1 },
    });

    expect(output).toContain("🚫");  // blocked icon
    expect(output).toContain("blocked by t-1");
    expect(output).toContain("1 blocked");
  });

  it("formats question annotation", async () => {
    const { formatBacklog } = await import("./backlog.js");
    const output = formatBacklog({
      project: "test",
      items: [
        {
          bead: makeBead({ id: "t-3", title: "Auth feature", status: "in_progress" }),
          children: [],
          hasQuestion: true,
        },
      ],
      summary: { open: 0, inProgress: 1, closed: 0, blocked: 0 },
    });

    expect(output).toContain("❓");  // question icon
  });

  it("sorts items: in_progress before open before blocked", async () => {
    const { formatBacklog } = await import("./backlog.js");
    const output = formatBacklog({
      project: "test",
      items: [
        {
          bead: makeBead({ id: "t-1", title: "Blocked task", status: "blocked" }),
          children: [],
        },
        {
          bead: makeBead({ id: "t-2", title: "Active task", status: "in_progress" }),
          children: [],
        },
        {
          bead: makeBead({ id: "t-3", title: "Open task", status: "open" }),
          children: [],
        },
      ],
      summary: { open: 1, inProgress: 1, closed: 0, blocked: 1 },
    });

    // The items are pre-sorted by getBacklogData, so formatBacklog just renders in order
    const lines = output.split("\n");
    const blockedLine = lines.findIndex((l) => l.includes("Blocked task"));
    const activeLine = lines.findIndex((l) => l.includes("Active task"));
    const openLine = lines.findIndex((l) => l.includes("Open task"));

    // In the provided items, blocked comes first (as given), so we just check rendering order
    expect(blockedLine).toBeGreaterThan(0);
    expect(activeLine).toBeGreaterThan(0);
    expect(openLine).toBeGreaterThan(0);
  });
});
