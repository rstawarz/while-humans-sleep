/**
 * Config management for While Humans Sleep
 *
 * WHS is project-based: config lives in .whs/ within the orchestrator directory.
 * Commands look for .whs/config.json in the current directory or parents.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import type { Config, Project } from "./types.js";

const WHS_FOLDER = ".whs";
const CONFIG_FILE = "config.json";

/**
 * Default config used when initializing a new orchestrator
 */
function createDefaultConfig(orchestratorPath: string): Config {
  return {
    projects: [],
    orchestratorPath: orchestratorPath,
    concurrency: {
      maxTotal: 4,
      maxPerProject: 2,
    },
    notifier: "cli",
  };
}

/**
 * Project pointer config - stored in project's .whs/config.json
 * Points back to the orchestrator
 */
interface ProjectPointerConfig {
  orchestratorPath: string;
}

/**
 * Checks if a config file is a project pointer (vs full orchestrator config)
 */
function isProjectPointer(config: unknown): config is ProjectPointerConfig {
  return (
    typeof config === "object" &&
    config !== null &&
    "orchestratorPath" in config &&
    !("projects" in config)
  );
}

/**
 * Creates a project pointer config in the project's .whs/ directory
 */
export function createProjectPointer(projectPath: string, orchestratorPath: string): void {
  const whsDir = join(projectPath, WHS_FOLDER);
  const configPath = join(whsDir, CONFIG_FILE);

  if (!existsSync(whsDir)) {
    mkdirSync(whsDir, { recursive: true });
  }

  const pointer: ProjectPointerConfig = {
    orchestratorPath: resolve(orchestratorPath),
  };

  writeFileSync(configPath, JSON.stringify(pointer, null, 2) + "\n", "utf-8");
}

/**
 * Finds the WHS config directory by walking up from startDir.
 * If a project pointer is found, follows it to the orchestrator.
 * Returns null if not in a WHS orchestrator or project.
 */
export function findConfigDir(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  const root = resolve("/");

  while (dir !== root) {
    const whsDir = join(dir, WHS_FOLDER);
    const configPath = join(whsDir, CONFIG_FILE);

    if (existsSync(configPath)) {
      // Check if this is a project pointer or the actual orchestrator
      try {
        const content = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(content);

        if (isProjectPointer(parsed)) {
          // Follow the pointer to the orchestrator
          const orchestratorConfigDir = join(parsed.orchestratorPath, WHS_FOLDER);
          if (existsSync(join(orchestratorConfigDir, CONFIG_FILE))) {
            return orchestratorConfigDir;
          }
          // Pointer is stale/invalid, continue searching
        } else {
          // This is the orchestrator config
          return whsDir;
        }
      } catch {
        // Invalid JSON, continue searching
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break; // Reached root
    dir = parent;
  }

  // Check root directory as well
  const rootWhsDir = join(root, WHS_FOLDER);
  if (existsSync(join(rootWhsDir, CONFIG_FILE))) {
    return rootWhsDir;
  }

  return null;
}

/**
 * Gets the WHS config directory.
 * Throws if not in a WHS orchestrator.
 *
 * @param startDir - Directory to start searching from (defaults to cwd)
 */
export function getConfigDir(startDir?: string): string {
  const dir = findConfigDir(startDir);
  if (!dir) {
    throw new Error(
      "Not in a WHS orchestrator. Run 'whs init' in the orchestrator directory to initialize."
    );
  }
  return dir;
}

/**
 * Ensures the .whs/ directory exists in the given directory.
 * Used during initialization.
 */
export function ensureConfigDir(baseDir: string = process.cwd()): string {
  const whsDir = join(baseDir, WHS_FOLDER);
  if (!existsSync(whsDir)) {
    mkdirSync(whsDir, { recursive: true });
  }
  return whsDir;
}

/**
 * Loads config from .whs/config.json
 * Throws if not in a WHS orchestrator.
 *
 * @param startDir - Directory to start searching from (defaults to cwd)
 */
export function loadConfig(startDir?: string): Config {
  const configDir = getConfigDir(startDir);
  const configPath = join(configDir, CONFIG_FILE);

  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content) as Partial<Config>;
    return validateConfig(parsed, configDir);
  } catch (err) {
    throw new Error(
      `Failed to load config from ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Saves config to .whs/config.json
 *
 * @param config - The config to save
 * @param startDir - Directory to start searching for .whs/ (defaults to cwd)
 */
export function saveConfig(config: Config, startDir?: string): void {
  const configDir = getConfigDir(startDir);
  const configPath = join(configDir, CONFIG_FILE);

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to save config to ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Validates and normalizes a parsed config object
 *
 * @param parsed - Partially parsed config
 * @param configDir - The .whs/ directory where config lives (used to derive orchestratorPath)
 */
function validateConfig(parsed: Partial<Config>, configDir: string): Config {
  // The orchestrator path is the parent of .whs/
  const derivedOrchestratorPath = dirname(configDir);

  const config: Config = {
    projects: parsed.projects ?? [],
    // Use the stored path or derive from config location
    orchestratorPath: parsed.orchestratorPath ?? derivedOrchestratorPath,
    concurrency: {
      maxTotal: parsed.concurrency?.maxTotal ?? 4,
      maxPerProject: parsed.concurrency?.maxPerProject ?? 2,
    },
    notifier: parsed.notifier ?? "cli",
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
 *
 * @param name - Project name
 * @param startDir - Directory to start searching for config (defaults to cwd)
 */
export function getProject(name: string, startDir?: string): Project | undefined {
  const config = loadConfig(startDir);
  return config.projects.find((p) => p.name === name);
}

/**
 * Adds a project to the config
 * Returns true if added, false if already exists
 *
 * @param name - Project name
 * @param repoPath - Path to the project repository
 * @param options - Additional project options
 * @param startDir - Directory to start searching for config (defaults to cwd)
 */
export function addProject(
  name: string,
  repoPath: string,
  options: {
    baseBranch?: string;
    agentsPath?: string;
    beadsMode?: "committed" | "stealth";
  } = {},
  startDir?: string
): boolean {
  const config = loadConfig(startDir);

  // Check if project already exists
  if (config.projects.some((p) => p.name === name)) {
    return false;
  }

  const resolvedRepoPath = expandPath(repoPath);

  const project: Project = {
    name,
    repoPath: resolvedRepoPath,
    baseBranch: options.baseBranch ?? "main",
    agentsPath: options.agentsPath ?? "docs/llm/agents",
    beadsMode: options.beadsMode ?? "committed",
  };

  config.projects.push(project);
  saveConfig(config, startDir);

  // Create a pointer in the project's .whs/ so commands work from the project directory
  createProjectPointer(resolvedRepoPath, config.orchestratorPath);

  return true;
}

/**
 * Removes a project from the config
 * Returns true if removed, false if not found
 *
 * @param name - Project name
 * @param startDir - Directory to start searching for config (defaults to cwd)
 */
export function removeProject(name: string, startDir?: string): boolean {
  const config = loadConfig(startDir);
  const initialLength = config.projects.length;
  config.projects = config.projects.filter((p) => p.name !== name);

  if (config.projects.length === initialLength) {
    return false;
  }

  saveConfig(config, startDir);
  return true;
}

/**
 * Updates a project in the config
 * Returns true if updated, false if not found
 *
 * @param name - Project name
 * @param updates - Fields to update
 * @param startDir - Directory to start searching for config (defaults to cwd)
 */
export function updateProject(
  name: string,
  updates: Partial<Omit<Project, "name">>,
  startDir?: string
): boolean {
  const config = loadConfig(startDir);
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

  saveConfig(config, startDir);
  return true;
}

/**
 * Lists all project names
 *
 * @param startDir - Directory to start searching for config (defaults to cwd)
 */
export function listProjects(startDir?: string): string[] {
  const config = loadConfig(startDir);
  return config.projects.map((p) => p.name);
}

/**
 * Updates concurrency settings
 *
 * @param settings - Concurrency settings to update
 * @param startDir - Directory to start searching for config (defaults to cwd)
 */
export function updateConcurrency(
  settings: {
    maxTotal?: number;
    maxPerProject?: number;
  },
  startDir?: string
): void {
  const config = loadConfig(startDir);

  if (settings.maxTotal !== undefined) {
    config.concurrency.maxTotal = settings.maxTotal;
  }
  if (settings.maxPerProject !== undefined) {
    config.concurrency.maxPerProject = settings.maxPerProject;
  }

  saveConfig(config, startDir);
}

/**
 * Updates orchestrator path in config
 *
 * @param path - New orchestrator path
 * @param startDir - Directory to start searching for config (defaults to cwd)
 */
export function setOrchestratorPath(path: string, startDir?: string): void {
  const config = loadConfig(startDir);
  config.orchestratorPath = expandPath(path);
  saveConfig(config, startDir);
}

/**
 * Gets the config file path
 *
 * @param startDir - Directory to start searching for config (defaults to cwd)
 */
export function getConfigPath(startDir?: string): string {
  const configDir = getConfigDir(startDir);
  return join(configDir, CONFIG_FILE);
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
 * Loads environment variables from the WHS .env file
 *
 * This loads ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN from ~/.whs/.env
 * and returns them merged with process.env.
 *
 * @param startDir - Directory to start searching for config (defaults to cwd)
 * @returns Environment object with WHS credentials merged in
 */
export function loadWhsEnv(startDir?: string): Record<string, string | undefined> {
  const configDir = findConfigDir(startDir);
  if (!configDir) {
    return { ...process.env };
  }

  const envPath = join(configDir, ".env");
  if (!existsSync(envPath)) {
    return { ...process.env };
  }

  try {
    const envContent = readFileSync(envPath, "utf-8");
    const envVars: Record<string, string> = {};

    // Parse .env file (simple KEY=value format)
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        envVars[key] = value;
      }
    }

    // Merge with process.env (WHS .env takes precedence for auth vars)
    return {
      ...process.env,
      ...envVars,
    };
  } catch {
    return { ...process.env };
  }
}

/**
 * Checks if WHS has been initialized in the current directory tree
 *
 * @param startDir - Directory to start searching from (defaults to cwd)
 */
export function isInitialized(startDir?: string): boolean {
  return findConfigDir(startDir) !== null;
}

/**
 * Checks if WHS has been initialized in a specific directory (not parents)
 *
 * @param dir - Directory to check
 */
export function isInitializedInDir(dir: string): boolean {
  return existsSync(join(dir, WHS_FOLDER, CONFIG_FILE));
}

/**
 * Initializes WHS in the specified directory.
 * Creates .whs/config.json with the orchestrator path set to that directory.
 *
 * @param orchestratorDir - The directory to initialize as an orchestrator (defaults to cwd)
 */
export function initializeWhs(orchestratorDir: string = process.cwd()): Config {
  const resolvedDir = resolve(orchestratorDir);
  const whsDir = join(resolvedDir, WHS_FOLDER);
  const configPath = join(whsDir, CONFIG_FILE);

  if (existsSync(configPath)) {
    throw new Error("WHS is already initialized. Config exists at " + configPath);
  }

  // Create .whs/ directory
  if (!existsSync(whsDir)) {
    mkdirSync(whsDir, { recursive: true });
  }

  // Create config with orchestrator path pointing to this directory
  const config = createDefaultConfig(resolvedDir);

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to create config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return config;
}

/**
 * Gets the default orchestrator path (current working directory)
 */
export function getDefaultOrchestratorPath(): string {
  return process.cwd();
}

/**
 * Gets the orchestrator path from the current context.
 * This is where the .whs/ folder lives.
 *
 * @param startDir - Directory to start searching from (defaults to cwd)
 */
export function getOrchestratorPathFromConfig(startDir?: string): string {
  const configDir = getConfigDir(startDir);
  // Orchestrator is the parent of .whs/
  return dirname(configDir);
}
