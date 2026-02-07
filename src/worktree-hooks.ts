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
import { join, resolve, basename } from "path";
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
  const hasDockerCompose =
    existsSync(join(projectPath, "docker-compose.yml")) ||
    existsSync(join(projectPath, "docker-compose.yaml"));
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

  // Read docker-compose content
  let dockerComposeContent: string | undefined;
  if (hasDockerCompose) {
    const composePath = existsSync(join(projectPath, "docker-compose.yml"))
      ? "docker-compose.yml"
      : "docker-compose.yaml";
    try {
      dockerComposeContent = readFileSync(join(projectPath, composePath), "utf-8");
    } catch {
      // Ignore
    }
  }

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
  };
}

/**
 * Builds the analysis prompt for Claude
 */
function buildAnalysisPrompt(info: ProjectInfo): string {
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
- Copy \`.env\` from \`{{ primary_worktree_path }}\` and patch DATABASE_URL with sed
- Clean up databases in \`[post-remove]\`
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
    sections.push(`\n**docker-compose.yml:**\n\`\`\`yaml\n${info.dockerComposeContent}\n\`\`\``);
  }

  if (info.hasMakefile && info.makeTargets.length > 0) {
    sections.push(`\n**Makefile targets:** ${info.makeTargets.join(", ")}`);
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
 * Analyzes a project and generates worktrunk hook suggestions using Claude
 */
export async function analyzeProjectForHooks(
  projectPath: string,
  runner: AgentRunner
): Promise<HookSuggestion> {
  const resolvedPath = resolve(projectPath);
  const projectInfo = gatherProjectInfo(resolvedPath);
  const prompt = buildAnalysisPrompt(projectInfo);

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
