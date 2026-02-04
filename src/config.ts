/**
 * Config management for While Humans Sleep
 *
 * Manages ~/.whs/config.json for project registry and settings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Config, Project } from "./types.js";

const WHS_DIR = join(homedir(), ".whs");
const CONFIG_PATH = join(WHS_DIR, "config.json");

const DEFAULT_CONFIG: Config = {
  projects: [],
  orchestratorPath: join(homedir(), "work", "whs-orchestrator"),
  concurrency: {
    maxTotal: 4,
    maxPerProject: 2,
  },
  notifier: "cli",
};

/**
 * Ensures ~/.whs/ directory exists
 */
export function ensureConfigDir(): void {
  if (!existsSync(WHS_DIR)) {
    mkdirSync(WHS_DIR, { recursive: true });
  }
}

/**
 * Loads config from ~/.whs/config.json
 * Creates default config if file doesn't exist
 */
export function loadConfig(): Config {
  ensureConfigDir();

  if (!existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content) as Partial<Config>;
    return validateConfig(parsed);
  } catch (err) {
    throw new Error(
      `Failed to load config from ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Saves config to ~/.whs/config.json
 */
export function saveConfig(config: Config): void {
  ensureConfigDir();

  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to save config to ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Validates and normalizes a parsed config object
 */
function validateConfig(parsed: Partial<Config>): Config {
  const config: Config = {
    projects: parsed.projects ?? DEFAULT_CONFIG.projects,
    orchestratorPath:
      parsed.orchestratorPath ?? DEFAULT_CONFIG.orchestratorPath,
    concurrency: {
      maxTotal:
        parsed.concurrency?.maxTotal ?? DEFAULT_CONFIG.concurrency.maxTotal,
      maxPerProject:
        parsed.concurrency?.maxPerProject ??
        DEFAULT_CONFIG.concurrency.maxPerProject,
    },
    notifier: parsed.notifier ?? DEFAULT_CONFIG.notifier,
  };

  if (parsed.slack) {
    config.slack = parsed.slack;
  }

  // Validate projects have required fields
  for (const project of config.projects) {
    if (!project.name || !project.repoPath) {
      throw new Error(
        `Invalid project config: missing name or repoPath in ${JSON.stringify(project)}`
      );
    }
  }

  return config;
}

/**
 * Gets a project by name
 */
export function getProject(name: string): Project | undefined {
  const config = loadConfig();
  return config.projects.find((p) => p.name === name);
}

/**
 * Adds a project to the config
 * Returns true if added, false if already exists
 */
export function addProject(
  name: string,
  repoPath: string,
  options: {
    baseBranch?: string;
    agentsPath?: string;
    beadsMode?: "committed" | "stealth";
  } = {}
): boolean {
  const config = loadConfig();

  // Check if project already exists
  if (config.projects.some((p) => p.name === name)) {
    return false;
  }

  const project: Project = {
    name,
    repoPath: expandPath(repoPath),
    baseBranch: options.baseBranch ?? "main",
    agentsPath: options.agentsPath ?? "docs/llm/agents",
    beadsMode: options.beadsMode ?? "committed",
  };

  config.projects.push(project);
  saveConfig(config);
  return true;
}

/**
 * Removes a project from the config
 * Returns true if removed, false if not found
 */
export function removeProject(name: string): boolean {
  const config = loadConfig();
  const initialLength = config.projects.length;
  config.projects = config.projects.filter((p) => p.name !== name);

  if (config.projects.length === initialLength) {
    return false;
  }

  saveConfig(config);
  return true;
}

/**
 * Updates a project in the config
 * Returns true if updated, false if not found
 */
export function updateProject(
  name: string,
  updates: Partial<Omit<Project, "name">>
): boolean {
  const config = loadConfig();
  const project = config.projects.find((p) => p.name === name);

  if (!project) {
    return false;
  }

  if (updates.repoPath !== undefined) {
    project.repoPath = expandPath(updates.repoPath);
  }
  if (updates.baseBranch !== undefined) {
    project.baseBranch = updates.baseBranch;
  }
  if (updates.agentsPath !== undefined) {
    project.agentsPath = updates.agentsPath;
  }
  if (updates.beadsMode !== undefined) {
    project.beadsMode = updates.beadsMode;
  }

  saveConfig(config);
  return true;
}

/**
 * Lists all project names
 */
export function listProjects(): string[] {
  const config = loadConfig();
  return config.projects.map((p) => p.name);
}

/**
 * Updates concurrency settings
 */
export function updateConcurrency(settings: {
  maxTotal?: number;
  maxPerProject?: number;
}): void {
  const config = loadConfig();

  if (settings.maxTotal !== undefined) {
    config.concurrency.maxTotal = settings.maxTotal;
  }
  if (settings.maxPerProject !== undefined) {
    config.concurrency.maxPerProject = settings.maxPerProject;
  }

  saveConfig(config);
}

/**
 * Updates orchestrator path
 */
export function setOrchestratorPath(path: string): void {
  const config = loadConfig();
  config.orchestratorPath = expandPath(path);
  saveConfig(config);
}

/**
 * Gets the config directory path
 */
export function getConfigDir(): string {
  return WHS_DIR;
}

/**
 * Gets the config file path
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Expands ~ to home directory in paths
 */
export function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", homedir());
  }
  return path;
}

/**
 * Checks if WHS has been initialized
 */
export function isInitialized(): boolean {
  return existsSync(CONFIG_PATH);
}

/**
 * Initializes WHS with the given orchestrator path
 */
export function initializeWhs(orchestratorPath: string): Config {
  ensureConfigDir();

  if (existsSync(CONFIG_PATH)) {
    throw new Error("WHS is already initialized. Config exists at " + CONFIG_PATH);
  }

  const config: Config = {
    ...DEFAULT_CONFIG,
    orchestratorPath: expandPath(orchestratorPath),
  };

  saveConfig(config);
  return config;
}

/**
 * Gets the default orchestrator path
 */
export function getDefaultOrchestratorPath(): string {
  return DEFAULT_CONFIG.orchestratorPath;
}
