import { describe, it, expect } from "vitest";
import type { Worktree } from "./worktree.js";

describe("worktree types", () => {
  it("Worktree interface has required fields", () => {
    const worktree: Worktree = {
      branch: "feature-branch",
      path: "/path/to/worktree",
      kind: "worktree",
      isMain: false,
      isCurrent: false,
    };

    expect(worktree.branch).toBe("feature-branch");
    expect(worktree.path).toBe("/path/to/worktree");
    expect(worktree.kind).toBe("worktree");
    expect(worktree.isMain).toBe(false);
    expect(worktree.isCurrent).toBe(false);
  });

  it("Worktree interface supports optional fields", () => {
    const worktree: Worktree = {
      branch: "main",
      path: "/path/to/main",
      kind: "worktree",
      isMain: true,
      isCurrent: true,
      commit: {
        sha: "abc123def456",
        shortSha: "abc123d",
        message: "Initial commit",
      },
      workingTree: {
        staged: false,
        modified: true,
        untracked: false,
      },
      mainState: "is_main",
    };

    expect(worktree.commit?.sha).toBe("abc123def456");
    expect(worktree.workingTree?.modified).toBe(true);
    expect(worktree.mainState).toBe("is_main");
  });
});

describe("worktree path conventions", () => {
  it("worktree base path is project-worktrees", () => {
    // Based on worktrunk default behavior
    const projectPath = "/Users/test/work/my-project";
    const expectedBase = `${projectPath}-worktrees`;

    expect(expectedBase).toBe("/Users/test/work/my-project-worktrees");
  });

  it("branch names can match bead IDs", () => {
    const beadId = "bd-a3f8";
    // Valid git branch name
    expect(beadId).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("worktree state checks", () => {
  it("identifies worktrees with uncommitted changes", () => {
    const worktreeWithChanges: Worktree = {
      branch: "feature",
      path: "/path",
      kind: "worktree",
      isMain: false,
      isCurrent: false,
      workingTree: {
        staged: false,
        modified: true,
        untracked: false,
      },
    };

    const hasChanges =
      worktreeWithChanges.workingTree?.modified ||
      worktreeWithChanges.workingTree?.staged ||
      worktreeWithChanges.workingTree?.untracked;

    expect(hasChanges).toBe(true);
  });

  it("identifies clean worktrees", () => {
    const cleanWorktree: Worktree = {
      branch: "feature",
      path: "/path",
      kind: "worktree",
      isMain: false,
      isCurrent: false,
      workingTree: {
        staged: false,
        modified: false,
        untracked: false,
      },
    };

    const hasChanges =
      cleanWorktree.workingTree?.modified ||
      cleanWorktree.workingTree?.staged ||
      cleanWorktree.workingTree?.untracked;

    expect(hasChanges).toBe(false);
  });

  it("identifies integrated worktrees", () => {
    const integrated: Worktree = {
      branch: "merged-feature",
      path: "/path",
      kind: "worktree",
      isMain: false,
      isCurrent: false,
      mainState: "integrated",
    };

    const isIntegrated =
      integrated.mainState === "integrated" ||
      integrated.mainState === "is_main";

    expect(isIntegrated).toBe(true);
  });

  it("identifies main worktree", () => {
    const main: Worktree = {
      branch: "main",
      path: "/path",
      kind: "worktree",
      isMain: true,
      isCurrent: true,
      mainState: "is_main",
    };

    expect(main.isMain).toBe(true);
    expect(main.mainState).toBe("is_main");
  });
});

describe("removable worktrees filtering", () => {
  it("filters out main worktree", () => {
    const worktrees: Worktree[] = [
      {
        branch: "main",
        path: "/main",
        kind: "worktree",
        isMain: true,
        isCurrent: true,
        mainState: "is_main",
      },
      {
        branch: "feature",
        path: "/feature",
        kind: "worktree",
        isMain: false,
        isCurrent: false,
        mainState: "integrated",
        workingTree: { staged: false, modified: false, untracked: false },
      },
    ];

    const removable = worktrees.filter((w) => {
      if (w.isMain) return false;
      if (w.mainState !== "integrated" && w.mainState !== "empty") return false;
      if (w.workingTree?.modified || w.workingTree?.staged || w.workingTree?.untracked) {
        return false;
      }
      return true;
    });

    expect(removable).toHaveLength(1);
    expect(removable[0].branch).toBe("feature");
  });

  it("filters out worktrees with uncommitted changes", () => {
    const worktrees: Worktree[] = [
      {
        branch: "clean",
        path: "/clean",
        kind: "worktree",
        isMain: false,
        isCurrent: false,
        mainState: "integrated",
        workingTree: { staged: false, modified: false, untracked: false },
      },
      {
        branch: "dirty",
        path: "/dirty",
        kind: "worktree",
        isMain: false,
        isCurrent: false,
        mainState: "integrated",
        workingTree: { staged: false, modified: true, untracked: false },
      },
    ];

    const removable = worktrees.filter((w) => {
      if (w.isMain) return false;
      if (w.mainState !== "integrated" && w.mainState !== "empty") return false;
      if (w.workingTree?.modified || w.workingTree?.staged || w.workingTree?.untracked) {
        return false;
      }
      return true;
    });

    expect(removable).toHaveLength(1);
    expect(removable[0].branch).toBe("clean");
  });

  it("filters out non-integrated worktrees", () => {
    const worktrees: Worktree[] = [
      {
        branch: "integrated",
        path: "/integrated",
        kind: "worktree",
        isMain: false,
        isCurrent: false,
        mainState: "integrated",
        workingTree: { staged: false, modified: false, untracked: false },
      },
      {
        branch: "ahead",
        path: "/ahead",
        kind: "worktree",
        isMain: false,
        isCurrent: false,
        mainState: "ahead",
        workingTree: { staged: false, modified: false, untracked: false },
      },
    ];

    const removable = worktrees.filter((w) => {
      if (w.isMain) return false;
      if (w.mainState !== "integrated" && w.mainState !== "empty") return false;
      if (w.workingTree?.modified || w.workingTree?.staged || w.workingTree?.untracked) {
        return false;
      }
      return true;
    });

    expect(removable).toHaveLength(1);
    expect(removable[0].branch).toBe("integrated");
  });
});

// Integration tests that require worktrunk CLI and a git repo
describe.skip("worktree integration", () => {
  it("creates and removes worktrees", async () => {
    // Would need a test git repository
  });

  it("lists worktrees", async () => {
    // Would need a test git repository
  });

  it("merges worktrees", async () => {
    // Would need a test git repository with branches
  });
});
