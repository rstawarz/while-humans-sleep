/**
 * Worktree Hooks - Analyze projects and generate worktrunk hook configs
 *
 * When WHS dispatches an agent to a newly created worktree, the worktree
 * needs setup (dependencies, env files, databases). This module analyzes
 * projects and generates `.config/wt.toml` configurations for worktrunk's
 * post-create hooks.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join, resolve, basename, dirname } from "path";
import { parse as parseYaml } from "yaml";
import type { AgentRunner } from "./agent-runner-interface.js";

/**
 * Suggested hooks for a project's worktrunk config
 */
export interface HookSuggestion {
  postCreate: Record<string, string>;
  postRemove: Record<string, string>;
  listUrl?: string;
}

/**
 * A sibling project's existing wt.toml, used as reference for the analysis agent
 */
export interface SiblingHook {
  projectName: string;
  tomlContent: string;
}

/**
 * Information gathered about a project's structure for analysis
 */
export interface ProjectInfo {
  name: string;
  path: string;
  hasPackageJson: boolean;
  hasPackageLock: boolean;
  hasWorkspaces: boolean;
  workspaces: string[];
  hasGemfile: boolean;
  hasRequirementsTxt: boolean;
  hasPyprojectToml: boolean;
  hasDockerCompose: boolean;
  hasEnvExample: boolean;
  hasEnvFile: boolean;
  envExamplePath?: string;
  hasPrisma: boolean;
  prismaLocations: string[];
  hasRailsMigrations: boolean;
  hasMakefile: boolean;
  makeTargets: string[];
  topLevelEntries: string[];
  workspaceDetails: WorkspaceDetail[];
  packageJsonContent?: string;
  envExampleContent?: string;
  dockerComposeContent?: string;
  /** All docker-compose files found (relative paths) */
  dockerComposePaths: string[];
  /** Content of shared infrastructure compose file (defines external networks) */
  sharedServicesContent?: string;
  /** Path to the shared infrastructure compose file */
  sharedServicesPath?: string;
}

/**
 * Details about a workspace in a monorepo
 */
interface WorkspaceDetail {
  name: string;
  path: string;
  hasPackageJson: boolean;
  hasEnv: boolean;
  hasEnvExample: boolean;
  hasPrisma: boolean;
}

const WT_CONFIG_DIR = ".config";
const WT_CONFIG_FILE = "wt.toml";
const WT_CONFIG_PATH = `${WT_CONFIG_DIR}/${WT_CONFIG_FILE}`;

/**
 * Common locations to check for docker-compose files within a project
 */
const COMPOSE_LOCATIONS = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "docker/docker-compose.yml",
  "docker/docker-compose.yaml",
];

/**
 * Extract external network names from a docker-compose file.
 * These are networks the project depends on but doesn't define.
 */
function extractExternalNetworks(composeContent: string): string[] {
  try {
    const doc = parseYaml(composeContent);
    if (!doc?.networks) return [];

    const networks: string[] = [];
    for (const [name, config] of Object.entries(doc.networks)) {
      const cfg = config as Record<string, unknown> | null;
      if (cfg?.external === true) {
        // Use explicit name if set, otherwise use the key
        const networkName = typeof cfg.name === "string" ? cfg.name : name;
        networks.push(networkName);
      }
    }
    return networks;
  } catch {
    return [];
  }
}

/**
 * Check if a docker-compose file defines (creates) a network with the given name.
 * A network is "defined" if it appears in the networks section without external: true.
 */
function definesNetwork(composeContent: string, networkName: string): boolean {
  try {
    const doc = parseYaml(composeContent);
    if (!doc?.networks) return false;

    for (const [key, config] of Object.entries(doc.networks)) {
      const cfg = config as Record<string, unknown> | null;
      // Skip external references — we want definitions
      if (cfg?.external === true) continue;

      // Match by key name or explicit name property
      if (key === networkName) return true;
      if (cfg && typeof cfg.name === "string" && cfg.name === networkName) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Search sibling directories for a docker-compose file that defines
 * the external networks referenced by this project's compose files.
 */
function findSharedServicesCompose(
  projectPath: string,
  composeContents: string[]
): { content: string; path: string } | undefined {
  // Collect all external network names from the project's compose files
  const externalNetworks: string[] = [];
  for (const content of composeContents) {
    externalNetworks.push(...extractExternalNetworks(content));
  }
  if (externalNetworks.length === 0) return undefined;

  // Scan sibling directories under the same parent (e.g., ~/work/*)
  const workDir = dirname(projectPath);
  let entries: string[];
  try {
    entries = readdirSync(workDir);
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const siblingPath = join(workDir, entry);
    if (siblingPath === projectPath) continue;

    // Check standard compose locations
    const candidatePaths = [...COMPOSE_LOCATIONS];

    // Also check one level deeper for infrastructure-style layouts
    // (e.g., templates/shared-services/, infrastructure/db/)
    for (const subdir of ["templates", "infrastructure", "infra", "shared"]) {
      const subdirPath = join(siblingPath, subdir);
      try {
        if (existsSync(subdirPath)) {
          for (const sub of readdirSync(subdirPath)) {
            candidatePaths.push(join(subdir, sub, "docker-compose.yml"));
            candidatePaths.push(join(subdir, sub, "docker-compose.yaml"));
          }
        }
      } catch {
        /* ignore unreadable dirs */
      }
    }

    for (const composeLoc of candidatePaths) {
      const fullPath = join(siblingPath, composeLoc);
      if (!existsSync(fullPath)) continue;

      try {
        const content = readFileSync(fullPath, "utf-8");
        for (const network of externalNetworks) {
          if (definesNetwork(content, network)) {
            return { content, path: fullPath };
          }
        }
      } catch {
        /* ignore unreadable files */
      }
    }
  }

  return undefined;
}

/**
 * Checks if a project already has a worktrunk config
 */
export function hasWtConfig(projectPath: string): boolean {
  return existsSync(join(projectPath, WT_CONFIG_PATH));
}

/**
 * Result of checking hook approvals for a project
 */
export interface HookApprovalStatus {
  hasConfig: boolean;
  allApproved: boolean;
  unapprovedCount: number;
}

/**
 * Checks whether all worktrunk hooks for a project are approved.
 *
 * Returns approval status. If the project has no .config/wt.toml,
 * returns hasConfig: false (nothing to approve).
 */
export function checkHookApprovals(projectPath: string): HookApprovalStatus {
  if (!hasWtConfig(projectPath)) {
    return { hasConfig: false, allApproved: true, unapprovedCount: 0 };
  }

  try {
    const output = execSync("wt hook show", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const unapprovedCount = (output.match(/\(requires approval\)/g) || []).length;
    return {
      hasConfig: true,
      allApproved: unapprovedCount === 0,
      unapprovedCount,
    };
  } catch {
    // wt not installed or other error — can't check, assume OK
    return { hasConfig: true, allApproved: true, unapprovedCount: 0 };
  }
}

/**
 * Gathers information about a project's structure for hook analysis
 *
 * Pre-reads key files to build context, avoiding spending agent turns
 * on file reading.
 */
export function gatherProjectInfo(projectPath: string): ProjectInfo {
  const name = basename(projectPath);

  // Check for key files
  const hasPackageJson = existsSync(join(projectPath, "package.json"));
  const hasPackageLock = existsSync(join(projectPath, "package-lock.json"));
  const hasGemfile = existsSync(join(projectPath, "Gemfile"));
  const hasRequirementsTxt = existsSync(join(projectPath, "requirements.txt"));
  const hasPyprojectToml = existsSync(join(projectPath, "pyproject.toml"));
  // Find all docker-compose files
  const dockerComposePaths: string[] = [];
  const dockerComposeContents: string[] = [];
  for (const loc of COMPOSE_LOCATIONS) {
    const fullPath = join(projectPath, loc);
    if (existsSync(fullPath)) {
      dockerComposePaths.push(loc);
      try {
        dockerComposeContents.push(readFileSync(fullPath, "utf-8"));
      } catch {
        /* ignore */
      }
    }
  }
  const hasDockerCompose = dockerComposePaths.length > 0;
  const hasMakefile = existsSync(join(projectPath, "Makefile"));
  const hasRailsMigrations =
    existsSync(join(projectPath, "db", "schema.rb")) ||
    existsSync(join(projectPath, "db", "migrate"));

  // Check for env files
  let hasEnvExample = false;
  let envExamplePath: string | undefined;
  for (const envName of [".env.example", ".env.sample"]) {
    if (existsSync(join(projectPath, envName))) {
      hasEnvExample = true;
      envExamplePath = envName;
      break;
    }
  }
  const hasEnvFile = existsSync(join(projectPath, ".env"));

  // Check for Prisma at root
  const hasPrismaRoot = existsSync(join(projectPath, "prisma", "schema.prisma"));
  const prismaLocations: string[] = [];
  if (hasPrismaRoot) {
    prismaLocations.push("prisma/schema.prisma");
  }

  // Parse workspaces from package.json
  let hasWorkspaces = false;
  let workspaces: string[] = [];
  let packageJsonContent: string | undefined;
  if (hasPackageJson) {
    try {
      packageJsonContent = readFileSync(join(projectPath, "package.json"), "utf-8");
      const pkg = JSON.parse(packageJsonContent);
      if (Array.isArray(pkg.workspaces)) {
        hasWorkspaces = true;
        workspaces = pkg.workspaces;
      } else if (pkg.workspaces?.packages) {
        hasWorkspaces = true;
        workspaces = pkg.workspaces.packages;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Scan workspace directories
  const workspaceDetails: WorkspaceDetail[] = [];
  for (const ws of workspaces) {
    // Simple workspace names (no globs)
    const wsPath = join(projectPath, ws);
    if (!existsSync(wsPath)) continue;

    const detail: WorkspaceDetail = {
      name: ws,
      path: ws,
      hasPackageJson: existsSync(join(wsPath, "package.json")),
      hasEnv: existsSync(join(wsPath, ".env")),
      hasEnvExample:
        existsSync(join(wsPath, ".env.example")) ||
        existsSync(join(wsPath, ".env.sample")),
      hasPrisma: existsSync(join(wsPath, "prisma", "schema.prisma")),
    };

    if (detail.hasPrisma) {
      prismaLocations.push(`${ws}/prisma/schema.prisma`);
    }

    workspaceDetails.push(detail);
  }

  // Read env example content
  let envExampleContent: string | undefined;
  if (envExamplePath) {
    try {
      envExampleContent = readFileSync(join(projectPath, envExamplePath), "utf-8");
    } catch {
      // Ignore
    }
  }

  // Use the first compose file content for backward compat
  const dockerComposeContent = dockerComposeContents[0];

  // Find shared infrastructure compose (e.g., shared Postgres/Redis container)
  const sharedServices = findSharedServicesCompose(projectPath, dockerComposeContents);
  const sharedServicesContent = sharedServices?.content;
  const sharedServicesPath = sharedServices?.path;

  // Parse Makefile targets
  const makeTargets: string[] = [];
  if (hasMakefile) {
    try {
      const content = readFileSync(join(projectPath, "Makefile"), "utf-8");
      const targetRegex = /^([a-zA-Z_][a-zA-Z0-9_-]*):/gm;
      let match;
      while ((match = targetRegex.exec(content)) !== null) {
        makeTargets.push(match[1]);
      }
    } catch {
      // Ignore
    }
  }

  // Get top-level directory listing
  let topLevelEntries: string[] = [];
  try {
    topLevelEntries = readdirSync(projectPath)
      .filter((e) => !e.startsWith("."))
      .sort();
  } catch {
    // Ignore
  }

  return {
    name,
    path: projectPath,
    hasPackageJson,
    hasPackageLock,
    hasWorkspaces,
    workspaces,
    hasGemfile,
    hasRequirementsTxt,
    hasPyprojectToml,
    hasDockerCompose,
    hasEnvExample,
    hasEnvFile,
    envExamplePath,
    hasPrisma: prismaLocations.length > 0,
    prismaLocations,
    hasRailsMigrations,
    hasMakefile,
    makeTargets,
    topLevelEntries,
    workspaceDetails,
    packageJsonContent,
    envExampleContent,
    dockerComposeContent,
    dockerComposePaths,
    sharedServicesContent,
    sharedServicesPath,
  };
}

/**
 * Builds the analysis prompt for Claude
 */
function buildAnalysisPrompt(info: ProjectInfo, siblingHooks?: SiblingHook[]): string {
  const sections: string[] = [];

  sections.push(`# Worktrunk Hook Analysis for "${info.name}"

You are analyzing a project to generate a \`.config/wt.toml\` configuration file for worktrunk (https://worktrunk.dev).

## What is worktrunk?

Worktrunk manages git worktrees. When a new worktree is created, it needs setup — dependencies installed, environment files copied, databases created. Worktrunk supports lifecycle hooks that run automatically.

## Hook Types

- \`[post-create]\` — Runs after a new worktree is created (blocking, before work starts)
- \`[post-remove]\` — Runs after a worktree is removed (cleanup)
- \`[list]\` — Metadata shown in \`wt list\` output

## Template Variables

- \`{{ primary_worktree_path }}\` — Path to the main/primary worktree (where .env files live)
- \`{{ branch }}\` — Branch name of the worktree
- \`{{ branch | sanitize_db }}\` — Branch name sanitized for database names (e.g., "bai_zv0_10_x7k")
- \`{{ branch | hash_port }}\` — Deterministic port number derived from branch name
- \`{{ repo_path }}\` — Path to the repository root

## TOML Format

Each hook is a key-value pair under a section. Multi-line values use triple quotes:

\`\`\`toml
[post-create]
install = "npm ci"

env = """
cp {{ primary_worktree_path }}/.env .env 2>/dev/null || true
"""
\`\`\`

## Monorepo Guidance

Some projects are **monorepos** with multiple packages/services (npm workspaces, Lerna, Turborepo, Rails engines, etc.). For monorepos:
- \`.env\` files may exist in subdirectories (e.g., \`api/.env\`, \`web/.env\`) — copy each from the primary worktree
- Database setup may be in a subdirectory (e.g., \`cd api && npx prisma migrate deploy\`)
- \`npm ci\` at root handles all workspaces for npm workspaces
- Each service may need its own DATABASE_URL override

## Database Isolation Guidance

- Use \`{{ branch | sanitize_db }}\` for unique database names per worktree
- Use \`createdb\`/\`dropdb\` for PostgreSQL
- Clean up databases in \`[post-remove]\`
- Only copy gitignored files (like \`.env\` with secrets) from \`{{ primary_worktree_path }}\`. Tracked files are already in the worktree.
- **NEVER modify tracked files** (sed on committed files creates dirty worktrees). Use \`.local\` override files instead.

### Node.js / Prisma projects
- Set \`DATABASE_URL\` in \`.env\` — Prisma reads it directly
- Copy \`.env\` from \`{{ primary_worktree_path }}\` and patch DATABASE_URL with sed (since \`.env\` is gitignored)

### Rails projects
- **\`DATABASE_URL\` does NOT override \`database.yml\`** when \`database:\` is set explicitly. Do not rely on \`DATABASE_URL\` for dev/test isolation.
- Instead, use \`dotenv-rails\` gem + environment variables in \`database.yml\`:
  - \`database.yml\`: \`database: <%= ENV.fetch("DATABASE_NAME", "myapp_development") %>\`
  - Checked-in defaults: \`api/.env.development\` with \`DATABASE_NAME=myapp_development\`
  - Worktree override: write \`api/.env.development.local\` with the branch-specific name
- \`.local\` files take precedence in dotenv-rails load order and are conventionally gitignored
- Example hook:
  \`\`\`
  echo 'DATABASE_NAME={{ branch | sanitize_db }}_development' > api/.env.development.local
  echo 'DATABASE_NAME={{ branch | sanitize_db }}_test' > api/.env.test.local
  \`\`\`
`);

  // Project info section
  sections.push("## Project Information\n");

  sections.push(`**Directory listing:** ${info.topLevelEntries.join(", ")}`);

  if (info.hasPackageJson) {
    sections.push(`\n**package.json:**\n\`\`\`json\n${info.packageJsonContent}\n\`\`\``);
  }

  if (info.hasWorkspaces) {
    sections.push(`\n**Monorepo:** npm workspaces: ${info.workspaces.join(", ")}`);
    for (const ws of info.workspaceDetails) {
      sections.push(`  - \`${ws.path}/\`: package.json=${ws.hasPackageJson}, .env=${ws.hasEnv}, .env.example=${ws.hasEnvExample}, prisma=${ws.hasPrisma}`);
    }
  }

  if (info.hasPackageLock) sections.push("**Has package-lock.json** — use `npm ci`");
  if (info.hasGemfile) sections.push("**Has Gemfile** — use `bundle install`");
  if (info.hasRequirementsTxt) sections.push("**Has requirements.txt** — use `pip install -r requirements.txt`");
  if (info.hasPyprojectToml) sections.push("**Has pyproject.toml** — use `pip install -e .` or `uv sync`");

  if (info.hasEnvExample) {
    sections.push(`\n**${info.envExamplePath}:**\n\`\`\`\n${info.envExampleContent}\n\`\`\``);
  }
  if (info.hasEnvFile) {
    sections.push("**Has .env file** (contains actual secrets — copy from primary worktree, don't template)");
  }

  if (info.hasPrisma) {
    sections.push(`\n**Prisma schemas:** ${info.prismaLocations.join(", ")}`);
    sections.push("Needs: `createdb`, `npx prisma migrate deploy`, `npx prisma generate`");
  }

  if (info.hasRailsMigrations) {
    sections.push("**Rails migrations** — needs `rails db:create` and `rails db:migrate`");
  }

  if (info.hasDockerCompose) {
    for (let i = 0; i < info.dockerComposePaths.length; i++) {
      const path = info.dockerComposePaths[i];
      // dockerComposeContents may not align 1:1 if reads failed, use dockerComposeContent for first
      const content = i === 0 ? info.dockerComposeContent : undefined;
      if (content) {
        sections.push(`\n**${path}:**\n\`\`\`yaml\n${content}\n\`\`\``);
      } else {
        sections.push(`\n**${path}** (found)`);
      }
    }
  }

  if (info.sharedServicesContent) {
    sections.push(`
## Shared Infrastructure

This project connects to an external Docker network. The following compose file provides shared services (database, cache, etc.) on that network:

**${info.sharedServicesPath}:**
\`\`\`yaml
${info.sharedServicesContent}
\`\`\`

When generating database setup hooks:
- Check if the database is reachable with \`pg_isready -h localhost -q\`
- If not running, start it with: \`docker compose -f ${info.sharedServicesPath} up -d postgres\`
- Wait for it to become ready with a retry loop and clear timeout error
- Log status messages (e.g., "PostgreSQL is ready on localhost:5432")
`);
  }

  if (info.hasMakefile && info.makeTargets.length > 0) {
    sections.push(`\n**Makefile targets:** ${info.makeTargets.join(", ")}`);
  }

  if (siblingHooks && siblingHooks.length > 0) {
    sections.push(`
## Reference: Existing Worktree Hooks

Other projects in this workspace already have worktree hooks. Use these as reference for infrastructure patterns (database startup, env file handling, cleanup, etc.). Adapt the patterns to this project's stack — don't copy verbatim.
`);
    for (const sibling of siblingHooks) {
      sections.push(`### ${sibling.projectName} (.config/wt.toml):\n\`\`\`toml\n${sibling.tomlContent}\n\`\`\``);
    }
  }

  sections.push(`
## Your Task

Based on the project information above, generate a JSON object with this shape:

\`\`\`json
{
  "postCreate": {
    "hook-name": "command or multi-line script"
  },
  "postRemove": {
    "hook-name": "command or script"
  },
  "listUrl": "http://localhost:{{ branch | hash_port }}"
}
\`\`\`

Guidelines:
- Only include hooks that are needed for this project
- Use \`npm ci\` over \`npm install\` when a lockfile exists
- Copy .env files from \`{{ primary_worktree_path }}\` and override DATABASE_URL
- Use \`{{ branch | sanitize_db }}\` for database names
- Use \`createdb\`/\`dropdb\` for PostgreSQL databases
- Add \`post-remove\` hooks to clean up databases
- Include a \`listUrl\` if the project has a dev server
- For multi-line commands, use \\n between lines
- Make commands idempotent (safe to re-run)

Return ONLY the JSON object, no explanation.`);

  return sections.join("\n");
}

/**
 * Parses Claude's response into HookSuggestion
 */
function parseHookSuggestions(output: string): HookSuggestion {
  // Try to find JSON in the output
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse hook suggestions from agent output: ${output.slice(0, 200)}`);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      postCreate: parsed.postCreate || {},
      postRemove: parsed.postRemove || {},
      listUrl: parsed.listUrl,
    };
  } catch (err) {
    throw new Error(`Failed to parse hook suggestions JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Formats a HookSuggestion as TOML for .config/wt.toml
 */
export function formatHooksAsToml(hooks: HookSuggestion): string {
  const lines: string[] = [];
  lines.push("# Worktree lifecycle hooks");
  lines.push("# Generated by: whs setup hooks");
  lines.push("# Docs: https://worktrunk.dev");
  lines.push("");

  // [post-create]
  const postCreateEntries = Object.entries(hooks.postCreate);
  if (postCreateEntries.length > 0) {
    lines.push("[post-create]");
    for (const [name, command] of postCreateEntries) {
      lines.push(formatTomlEntry(name, command));
      lines.push("");
    }
  }

  // [post-remove]
  const postRemoveEntries = Object.entries(hooks.postRemove);
  if (postRemoveEntries.length > 0) {
    lines.push("[post-remove]");
    for (const [name, command] of postRemoveEntries) {
      lines.push(formatTomlEntry(name, command));
      lines.push("");
    }
  }

  // [list]
  if (hooks.listUrl) {
    lines.push("[list]");
    lines.push(`url = "${hooks.listUrl}"`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Formats a single TOML entry, using multi-line strings for multi-line values
 */
function formatTomlEntry(name: string, value: string): string {
  // Normalize newlines
  const normalized = value.replace(/\\n/g, "\n").trim();

  if (normalized.includes("\n")) {
    return `${name} = """\n${normalized}\n"""`;
  }

  return `${name} = "${normalized}"`;
}

/**
 * Writes a worktrunk config to a project
 */
export function writeWtConfig(projectPath: string, tomlContent: string): void {
  const configDir = join(projectPath, WT_CONFIG_DIR);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const configPath = join(projectPath, WT_CONFIG_PATH);
  writeFileSync(configPath, tomlContent);
}

/**
 * Gather existing wt.toml files from sibling projects as reference.
 * Accepts the projects array from config and the current project path to exclude.
 */
export function gatherSiblingHooks(
  projects: Array<{ name: string; repoPath: string }>,
  currentProjectPath: string
): SiblingHook[] {
  const resolvedCurrent = resolve(currentProjectPath);
  const hooks: SiblingHook[] = [];

  for (const project of projects) {
    const projectPath = resolve(project.repoPath.replace(/^~/, process.env.HOME || "~"));
    if (projectPath === resolvedCurrent) continue;

    const wtTomlPath = join(projectPath, WT_CONFIG_DIR, WT_CONFIG_FILE);
    if (existsSync(wtTomlPath)) {
      try {
        hooks.push({
          projectName: project.name,
          tomlContent: readFileSync(wtTomlPath, "utf-8"),
        });
      } catch {
        /* ignore unreadable files */
      }
    }
  }

  return hooks;
}

/**
 * Analyzes a project and generates worktrunk hook suggestions using Claude
 */
export async function analyzeProjectForHooks(
  projectPath: string,
  runner: AgentRunner,
  siblingHooks?: SiblingHook[]
): Promise<HookSuggestion> {
  const resolvedPath = resolve(projectPath);
  const projectInfo = gatherProjectInfo(resolvedPath);
  const prompt = buildAnalysisPrompt(projectInfo, siblingHooks);

  const result = await runner.run({
    prompt,
    cwd: resolvedPath,
    maxTurns: 5,
  });

  if (!result.success) {
    throw new Error(`Agent analysis failed: ${result.error || "Unknown error"}`);
  }

  return parseHookSuggestions(result.output);
}
