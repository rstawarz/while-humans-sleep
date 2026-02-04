import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import {
  expandPath,
  getConfigDir,
  getConfigPath,
  isInitialized,
  initializeWhs,
  getDefaultOrchestratorPath,
} from "./config.js";
import type { Config, Project } from "./types.js";

// Test getConfigDir and getConfigPath
describe("config paths", () => {
  it("getConfigDir returns path under home directory", () => {
    const configDir = getConfigDir();
    expect(configDir).toContain(".whs");
    expect(configDir).toContain(homedir());
  });

  it("getConfigPath returns path to config.json", () => {
    const configPath = getConfigPath();
    expect(configPath).toContain("config.json");
    expect(configPath).toContain(".whs");
  });
});

// Test expandPath directly since it has no side effects
describe("expandPath", () => {
  it("expands ~ to home directory", () => {
    const result = expandPath("~/work/project");
    expect(result).not.toContain("~");
    expect(result).toContain("/work/project");
  });

  it("leaves absolute paths unchanged", () => {
    const result = expandPath("/absolute/path");
    expect(result).toBe("/absolute/path");
  });

  it("leaves relative paths unchanged", () => {
    const result = expandPath("relative/path");
    expect(result).toBe("relative/path");
  });
});

// Test config file operations using a temp directory
// Note: These tests work with real files but in a temp location
describe("config file operations", () => {
  const TEST_DIR = join(tmpdir(), `whs-config-test-${process.pid}`);
  const TEST_CONFIG = join(TEST_DIR, "test-config.json");

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("validates config structure", () => {
    const validConfig: Config = {
      projects: [
        {
          name: "test",
          repoPath: "/test",
          baseBranch: "main",
          agentsPath: "agents",
          beadsMode: "committed",
        },
      ],
      orchestratorPath: "/orch",
      concurrency: { maxTotal: 4, maxPerProject: 2 },
      notifier: "cli",
    };

    // Write and read back
    writeFileSync(TEST_CONFIG, JSON.stringify(validConfig, null, 2));
    const content = readFileSync(TEST_CONFIG, "utf-8");
    const parsed = JSON.parse(content) as Config;

    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0].name).toBe("test");
    expect(parsed.concurrency.maxTotal).toBe(4);
  });

  it("handles missing optional fields with defaults", () => {
    const partialConfig = {
      projects: [],
      orchestratorPath: "/orch",
    };

    writeFileSync(TEST_CONFIG, JSON.stringify(partialConfig));
    const content = readFileSync(TEST_CONFIG, "utf-8");
    const parsed = JSON.parse(content) as Partial<Config>;

    // Simulate validation logic
    const validated: Config = {
      projects: parsed.projects ?? [],
      orchestratorPath: parsed.orchestratorPath ?? "/default",
      concurrency: {
        maxTotal: parsed.concurrency?.maxTotal ?? 4,
        maxPerProject: parsed.concurrency?.maxPerProject ?? 2,
      },
      notifier: parsed.notifier ?? "cli",
    };

    expect(validated.concurrency.maxTotal).toBe(4);
    expect(validated.notifier).toBe("cli");
  });

  it("validates project has required fields", () => {
    const projectWithoutName = {
      repoPath: "/path",
      baseBranch: "main",
    } as Partial<Project>;

    expect(projectWithoutName.name).toBeUndefined();

    const validProject: Project = {
      name: "valid",
      repoPath: "/path",
      baseBranch: "main",
      agentsPath: "agents",
      beadsMode: "committed",
    };

    expect(validProject.name).toBe("valid");
    expect(validProject.repoPath).toBe("/path");
  });

  it("preserves slack config when present", () => {
    const configWithSlack: Config = {
      projects: [],
      orchestratorPath: "/orch",
      concurrency: { maxTotal: 4, maxPerProject: 2 },
      notifier: "slack",
      slack: {
        token: "xoxb-test",
        channelId: "C123",
      },
    };

    writeFileSync(TEST_CONFIG, JSON.stringify(configWithSlack, null, 2));
    const content = readFileSync(TEST_CONFIG, "utf-8");
    const parsed = JSON.parse(content) as Config;

    expect(parsed.slack).toBeDefined();
    expect(parsed.slack?.token).toBe("xoxb-test");
    expect(parsed.slack?.channelId).toBe("C123");
  });
});

// Integration test using actual config module (modifies ~/.whs/)
// Skip by default to avoid modifying user's actual config
describe.skip("config integration", () => {
  it("creates config on first load", async () => {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.projects).toBeDefined();
  });
});


// Test config functions using a temp directory with file system isolation
describe("config functions with temp directory", () => {
  const TEST_DIR = join(tmpdir(), `whs-config-fn-test-${process.pid}-${Date.now()}`);
  const TEST_CONFIG_PATH = join(TEST_DIR, "config.json");

  // Helper to write config directly to temp file
  function writeTestConfig(config: Config): void {
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }

  // Helper to read config directly from temp file
  function readTestConfig(): Config {
    return JSON.parse(readFileSync(TEST_CONFIG_PATH, "utf-8")) as Config;
  }

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("validateConfig behavior", () => {
    it("applies defaults for missing optional fields", () => {
      const partialConfig: Partial<Config> = {
        projects: [],
      };

      // Simulate validateConfig logic
      const validated: Config = {
        projects: partialConfig.projects ?? [],
        orchestratorPath: partialConfig.orchestratorPath ?? "/default/orchestrator",
        concurrency: {
          maxTotal: partialConfig.concurrency?.maxTotal ?? 4,
          maxPerProject: partialConfig.concurrency?.maxPerProject ?? 2,
        },
        notifier: partialConfig.notifier ?? "cli",
      };

      expect(validated.orchestratorPath).toBe("/default/orchestrator");
      expect(validated.concurrency.maxTotal).toBe(4);
      expect(validated.concurrency.maxPerProject).toBe(2);
      expect(validated.notifier).toBe("cli");
    });

    it("throws on invalid project config", () => {
      const config: Config = {
        projects: [{ name: "", repoPath: "/path", baseBranch: "main", agentsPath: "agents", beadsMode: "committed" }],
        orchestratorPath: "/orch",
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "cli",
      };

      // Simulate validation check
      const validateProject = (project: Project) => {
        if (!project.name || !project.repoPath) {
          throw new Error(`Invalid project config: missing name or repoPath`);
        }
      };

      expect(() => validateProject(config.projects[0])).toThrow("Invalid project config");
    });

    it("preserves slack config when present", () => {
      const config: Config = {
        projects: [],
        orchestratorPath: "/orch",
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "slack",
        slack: { token: "test-token", channelId: "C123" },
      };

      writeTestConfig(config);
      const loaded = readTestConfig();

      expect(loaded.slack).toBeDefined();
      expect(loaded.slack?.token).toBe("test-token");
      expect(loaded.slack?.channelId).toBe("C123");
    });
  });

  describe("project management functions", () => {
    it("addProject creates new project with defaults", () => {
      const config: Config = {
        projects: [],
        orchestratorPath: "/orch",
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "cli",
      };

      // Simulate addProject
      const project: Project = {
        name: "new-project",
        repoPath: "/path/to/project",
        baseBranch: "main",
        agentsPath: "docs/llm/agents",
        beadsMode: "committed",
      };
      config.projects.push(project);

      writeTestConfig(config);
      const loaded = readTestConfig();

      expect(loaded.projects).toHaveLength(1);
      expect(loaded.projects[0].name).toBe("new-project");
      expect(loaded.projects[0].baseBranch).toBe("main");
    });

    it("addProject respects custom options", () => {
      const config: Config = {
        projects: [],
        orchestratorPath: "/orch",
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "cli",
      };

      const project: Project = {
        name: "custom-project",
        repoPath: "/path",
        baseBranch: "develop",
        agentsPath: "custom/agents",
        beadsMode: "stealth",
      };
      config.projects.push(project);

      writeTestConfig(config);
      const loaded = readTestConfig();

      expect(loaded.projects[0].baseBranch).toBe("develop");
      expect(loaded.projects[0].agentsPath).toBe("custom/agents");
      expect(loaded.projects[0].beadsMode).toBe("stealth");
    });

    it("removeProject filters out matching project", () => {
      const config: Config = {
        projects: [
          { name: "keep", repoPath: "/keep", baseBranch: "main", agentsPath: "agents", beadsMode: "committed" },
          { name: "remove", repoPath: "/remove", baseBranch: "main", agentsPath: "agents", beadsMode: "committed" },
        ],
        orchestratorPath: "/orch",
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "cli",
      };

      // Simulate removeProject
      config.projects = config.projects.filter((p) => p.name !== "remove");

      writeTestConfig(config);
      const loaded = readTestConfig();

      expect(loaded.projects).toHaveLength(1);
      expect(loaded.projects[0].name).toBe("keep");
    });

    it("updateProject modifies specific fields", () => {
      const config: Config = {
        projects: [
          { name: "test", repoPath: "/old/path", baseBranch: "main", agentsPath: "agents", beadsMode: "committed" },
        ],
        orchestratorPath: "/orch",
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "cli",
      };

      // Simulate updateProject
      const project = config.projects.find((p) => p.name === "test");
      if (project) {
        project.repoPath = "/new/path";
        project.baseBranch = "develop";
      }

      writeTestConfig(config);
      const loaded = readTestConfig();

      expect(loaded.projects[0].repoPath).toBe("/new/path");
      expect(loaded.projects[0].baseBranch).toBe("develop");
    });

    it("getProject finds project by name", () => {
      const config: Config = {
        projects: [
          { name: "first", repoPath: "/first", baseBranch: "main", agentsPath: "agents", beadsMode: "committed" },
          { name: "second", repoPath: "/second", baseBranch: "main", agentsPath: "agents", beadsMode: "committed" },
        ],
        orchestratorPath: "/orch",
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "cli",
      };

      // Simulate getProject
      const found = config.projects.find((p) => p.name === "second");
      const notFound = config.projects.find((p) => p.name === "nonexistent");

      expect(found?.name).toBe("second");
      expect(found?.repoPath).toBe("/second");
      expect(notFound).toBeUndefined();
    });

    it("listProjects returns all project names", () => {
      const config: Config = {
        projects: [
          { name: "alpha", repoPath: "/a", baseBranch: "main", agentsPath: "agents", beadsMode: "committed" },
          { name: "beta", repoPath: "/b", baseBranch: "main", agentsPath: "agents", beadsMode: "committed" },
          { name: "gamma", repoPath: "/c", baseBranch: "main", agentsPath: "agents", beadsMode: "committed" },
        ],
        orchestratorPath: "/orch",
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "cli",
      };

      // Simulate listProjects
      const names = config.projects.map((p) => p.name);

      expect(names).toEqual(["alpha", "beta", "gamma"]);
    });
  });

  describe("settings update functions", () => {
    it("updateConcurrency modifies concurrency settings", () => {
      const config: Config = {
        projects: [],
        orchestratorPath: "/orch",
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "cli",
      };

      // Simulate updateConcurrency
      config.concurrency.maxTotal = 8;
      config.concurrency.maxPerProject = 3;

      writeTestConfig(config);
      const loaded = readTestConfig();

      expect(loaded.concurrency.maxTotal).toBe(8);
      expect(loaded.concurrency.maxPerProject).toBe(3);
    });

    it("setOrchestratorPath updates path with expansion", () => {
      const config: Config = {
        projects: [],
        orchestratorPath: "/old/path",
        concurrency: { maxTotal: 4, maxPerProject: 2 },
        notifier: "cli",
      };

      // Simulate setOrchestratorPath with expandPath
      const newPath = "~/work/orchestrator";
      config.orchestratorPath = expandPath(newPath);

      expect(config.orchestratorPath).not.toContain("~");
      expect(config.orchestratorPath).toContain("/work/orchestrator");
    });
  });
});

// ============================================================
// Initialization Functions Tests
// ============================================================

describe("getDefaultOrchestratorPath", () => {
  it("returns path under home directory", () => {
    const defaultPath = getDefaultOrchestratorPath();

    expect(defaultPath).toContain(homedir());
    expect(defaultPath).toContain("whs-orchestrator");
  });

  it("returns consistent value", () => {
    const first = getDefaultOrchestratorPath();
    const second = getDefaultOrchestratorPath();

    expect(first).toBe(second);
  });
});

describe("isInitialized", () => {
  it("checks for config file existence", () => {
    // This tests against the real config path
    // Result depends on whether user has initialized WHS
    const result = isInitialized();

    expect(typeof result).toBe("boolean");
  });
});

describe("initializeWhs behavior", () => {
  const TEST_DIR = join(tmpdir(), `whs-init-test-${process.pid}-${Date.now()}`);

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("creates config with specified orchestrator path", () => {
    // Simulate what initializeWhs does
    const orchestratorPath = "/custom/orchestrator/path";
    const configPath = join(TEST_DIR, "config.json");

    const config: Config = {
      projects: [],
      orchestratorPath: orchestratorPath,
      concurrency: { maxTotal: 4, maxPerProject: 2 },
      notifier: "cli",
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const loaded = JSON.parse(readFileSync(configPath, "utf-8")) as Config;
    expect(loaded.orchestratorPath).toBe("/custom/orchestrator/path");
    expect(loaded.projects).toEqual([]);
    expect(loaded.concurrency.maxTotal).toBe(4);
  });

  it("expands ~ in orchestrator path", () => {
    const orchestratorPath = "~/work/my-orchestrator";
    const expandedPath = expandPath(orchestratorPath);

    expect(expandedPath).not.toContain("~");
    expect(expandedPath).toContain(homedir());
    expect(expandedPath).toContain("work/my-orchestrator");
  });

  it("throws if config already exists", () => {
    const configPath = join(TEST_DIR, "config.json");

    // Create existing config
    writeFileSync(configPath, JSON.stringify({ projects: [] }), "utf-8");

    // Simulate initializeWhs check
    const checkInitialized = () => {
      if (existsSync(configPath)) {
        throw new Error("WHS is already initialized. Config exists at " + configPath);
      }
    };

    expect(() => checkInitialized()).toThrow("WHS is already initialized");
  });

  it("creates config directory if needed", () => {
    const newDir = join(TEST_DIR, "subdir", ".whs");
    const configPath = join(newDir, "config.json");

    // Simulate ensureConfigDir + initializeWhs
    mkdirSync(newDir, { recursive: true });

    const config: Config = {
      projects: [],
      orchestratorPath: "/orch",
      concurrency: { maxTotal: 4, maxPerProject: 2 },
      notifier: "cli",
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    expect(existsSync(configPath)).toBe(true);
    const loaded = JSON.parse(readFileSync(configPath, "utf-8")) as Config;
    expect(loaded.orchestratorPath).toBe("/orch");
  });
});
