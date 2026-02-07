import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  gatherProjectInfo,
  formatHooksAsToml,
  hasWtConfig,
  writeWtConfig,
} from "./worktree-hooks.js";
import type { HookSuggestion } from "./worktree-hooks.js";

// Mock fs for hasWtConfig and writeWtConfig tests
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: actual.existsSync,
    readFileSync: actual.readFileSync,
    readdirSync: actual.readdirSync,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

describe("gatherProjectInfo", () => {
  it("detects npm project with package.json", () => {
    // Use the WHS project itself as a test subject
    const info = gatherProjectInfo(process.cwd());

    expect(info.hasPackageJson).toBe(true);
    expect(info.hasPackageLock).toBe(true);
    expect(info.name).toBeDefined();
    expect(info.topLevelEntries.length).toBeGreaterThan(0);
  });

  it("detects monorepo workspaces from bridget_ai", () => {
    const bridgetPath = join(process.env.HOME || "", "work", "bridget_ai");
    // Skip if bridget_ai doesn't exist
    const { existsSync } = require("fs");
    if (!existsSync(bridgetPath)) return;

    const info = gatherProjectInfo(bridgetPath);

    expect(info.hasPackageJson).toBe(true);
    expect(info.hasWorkspaces).toBe(true);
    expect(info.workspaces).toContain("api");
    expect(info.workspaces).toContain("web");
    expect(info.workspaceDetails.length).toBeGreaterThan(0);
  });

  it("detects Prisma in workspace subdirectories", () => {
    const bridgetPath = join(process.env.HOME || "", "work", "bridget_ai");
    const { existsSync } = require("fs");
    if (!existsSync(bridgetPath)) return;

    const info = gatherProjectInfo(bridgetPath);

    expect(info.hasPrisma).toBe(true);
    expect(info.prismaLocations).toContain("api/prisma/schema.prisma");
  });

  it("detects .env files", () => {
    const bridgetPath = join(process.env.HOME || "", "work", "bridget_ai");
    const { existsSync } = require("fs");
    if (!existsSync(bridgetPath)) return;

    const info = gatherProjectInfo(bridgetPath);

    expect(info.hasEnvFile).toBe(true);
    expect(info.hasEnvExample).toBe(true);
    expect(info.envExamplePath).toBe(".env.example");
    expect(info.envExampleContent).toContain("DATABASE_URL");
  });

  it("returns structured info for non-existent optional features", () => {
    const info = gatherProjectInfo(process.cwd());

    // WHS doesn't have these
    expect(info.hasGemfile).toBe(false);
    expect(info.hasRequirementsTxt).toBe(false);
    expect(info.hasPyprojectToml).toBe(false);
    expect(info.hasRailsMigrations).toBe(false);
  });
});

describe("formatHooksAsToml", () => {
  it("formats simple single-command hooks", () => {
    const hooks: HookSuggestion = {
      postCreate: {
        install: "npm ci",
      },
      postRemove: {},
    };

    const toml = formatHooksAsToml(hooks);

    expect(toml).toContain("[post-create]");
    expect(toml).toContain('install = "npm ci"');
    expect(toml).not.toContain("[post-remove]");
  });

  it("formats multi-line commands with triple quotes", () => {
    const hooks: HookSuggestion = {
      postCreate: {
        env: "cp {{ primary_worktree_path }}/.env .env\nsed -i '' 's|DB=.*|DB=test|' .env",
      },
      postRemove: {},
    };

    const toml = formatHooksAsToml(hooks);

    expect(toml).toContain('[post-create]');
    expect(toml).toContain('env = """');
    expect(toml).toContain('cp {{ primary_worktree_path }}/.env .env');
    expect(toml).toContain('"""');
  });

  it("formats post-remove hooks", () => {
    const hooks: HookSuggestion = {
      postCreate: {
        install: "npm ci",
      },
      postRemove: {
        "db-cleanup": "dropdb --if-exists {{ branch | sanitize_db }}",
      },
    };

    const toml = formatHooksAsToml(hooks);

    expect(toml).toContain("[post-remove]");
    expect(toml).toContain('db-cleanup = "dropdb --if-exists {{ branch | sanitize_db }}"');
  });

  it("includes list URL when provided", () => {
    const hooks: HookSuggestion = {
      postCreate: {
        install: "npm ci",
      },
      postRemove: {},
      listUrl: "http://localhost:{{ branch | hash_port }}",
    };

    const toml = formatHooksAsToml(hooks);

    expect(toml).toContain("[list]");
    expect(toml).toContain('url = "http://localhost:{{ branch | hash_port }}"');
  });

  it("omits empty sections", () => {
    const hooks: HookSuggestion = {
      postCreate: {},
      postRemove: {},
    };

    const toml = formatHooksAsToml(hooks);

    expect(toml).not.toContain("[post-create]");
    expect(toml).not.toContain("[post-remove]");
    expect(toml).not.toContain("[list]");
  });

  it("includes header comment", () => {
    const hooks: HookSuggestion = {
      postCreate: { install: "npm ci" },
      postRemove: {},
    };

    const toml = formatHooksAsToml(hooks);

    expect(toml).toContain("# Worktree lifecycle hooks");
    expect(toml).toContain("# Generated by: whs setup hooks");
    expect(toml).toContain("# Docs: https://worktrunk.dev");
  });

  it("handles escaped newlines in command strings", () => {
    const hooks: HookSuggestion = {
      postCreate: {
        setup: "line1\\nline2\\nline3",
      },
      postRemove: {},
    };

    const toml = formatHooksAsToml(hooks);

    // Escaped newlines should become real newlines in multi-line TOML
    expect(toml).toContain('"""');
    expect(toml).toContain("line1");
    expect(toml).toContain("line2");
    expect(toml).toContain("line3");
  });

  it("produces full TOML for a realistic monorepo", () => {
    const hooks: HookSuggestion = {
      postCreate: {
        install: "npm ci",
        env: "cp {{ primary_worktree_path }}/.env .env 2>/dev/null || true\ncp {{ primary_worktree_path }}/api/.env api/.env 2>/dev/null || true\nif [ -f api/.env ]; then\n  sed -i '' 's|DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/{{ branch | sanitize_db }}|' api/.env\nfi",
        "db-setup": "createdb {{ branch | sanitize_db }} 2>/dev/null || true\ncd api && npx prisma migrate deploy && npx prisma generate",
      },
      postRemove: {
        "db-cleanup": "dropdb --if-exists {{ branch | sanitize_db }}",
      },
      listUrl: "http://localhost:{{ branch | hash_port }}",
    };

    const toml = formatHooksAsToml(hooks);

    // Verify all sections present
    expect(toml).toContain("[post-create]");
    expect(toml).toContain("[post-remove]");
    expect(toml).toContain("[list]");

    // Verify key hooks
    expect(toml).toContain('install = "npm ci"');
    expect(toml).toContain("{{ primary_worktree_path }}");
    expect(toml).toContain("{{ branch | sanitize_db }}");
    expect(toml).toContain("npx prisma migrate deploy");
    expect(toml).toContain("dropdb --if-exists");
    expect(toml).toContain("{{ branch | hash_port }}");
  });
});

describe("hasWtConfig", () => {
  it("returns true when .config/wt.toml exists", () => {
    const bridgetPath = join(process.env.HOME || "", "work", "bridget_ai");
    const { existsSync } = require("fs");
    if (!existsSync(join(bridgetPath, ".config", "wt.toml"))) return;

    expect(hasWtConfig(bridgetPath)).toBe(true);
  });

  it("returns false when .config/wt.toml does not exist", () => {
    // WHS project shouldn't have one
    expect(hasWtConfig(process.cwd())).toBe(false);
  });
});
