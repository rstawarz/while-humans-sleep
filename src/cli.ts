#!/usr/bin/env node

/**
 * While Humans Sleep - CLI
 */

import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import { Command } from "commander";
import { Dispatcher } from "./dispatcher.js";
import { CLINotifier } from "./notifiers/cli.js";
import {
  loadConfig,
  addProject,
  removeProject,
  getProject,
  listProjects,
  getConfigPath,
  getConfigDir,
  expandPath,
  isInitialized,
  isInitializedInDir,
  initializeWhs,
  findConfigDir,
} from "./config.js";
import { beads } from "./beads/index.js";
import {
  loadState,
  getStatePath,
  getLockInfo,
} from "./state.js";
import { VERSION, getVersionString } from "./version.js";
import { getStatusData, getStepDetail, formatDuration } from "./status.js";
import type { AgentLogEvent } from "./agent-log.js";

const program = new Command();

program
  .name("whs")
  .description("While Humans Sleep - Multi-project AI agent dispatcher")
  .version(getVersionString(), "-V, --version", "output version and build time");

/**
 * Checks if WHS is initialized and shows an error if not.
 * Returns true if initialized, false otherwise (and prints error).
 */
function requireOrchestrator(): boolean {
  if (!isInitialized()) {
    console.error("Error: Not in a WHS orchestrator.");
    console.error("");
    console.error("Either:");
    console.error("  1. cd to your WHS orchestrator directory, OR");
    console.error("  2. Run 'whs init' in a directory to create a new orchestrator");
    return false;
  }
  return true;
}

program
  .command("init")
  .description("Initialize WHS in the current directory as an orchestrator")
  .option("-p, --prefix <prefix>", "Bead ID prefix for orchestrator", "orc")
  .action(async (options) => {
    const orchestratorPath = process.cwd();

    // Check if already initialized in this exact directory
    if (isInitializedInDir(orchestratorPath)) {
      console.log("WHS is already initialized in this directory.");
      console.log(`  Config: ${getConfigPath()}`);
      const config = loadConfig();
      console.log(`  Orchestrator: ${config.orchestratorPath}`);
      console.log("");
      console.log("Use `whs add <path>` to add projects.");
      return;
    }

    // Check if there's already a WHS orchestrator in a parent directory
    const existingConfigDir = findConfigDir(orchestratorPath);
    if (existingConfigDir) {
      console.log("A WHS orchestrator already exists in a parent directory:");
      console.log(`  ${existingConfigDir}`);
      console.log("");
      console.log("You can either:");
      console.log("  - Use the existing orchestrator from this directory");
      console.log("  - Move to a different location to create a new orchestrator");
      return;
    }

    console.log("🌙 Initializing While Humans Sleep\n");
    console.log(`  Orchestrator: ${orchestratorPath}`);
    console.log(`  Config: ${orchestratorPath}/.whs/config.json`);
    console.log("");

    // 1. Initialize git repo if not present
    const gitDir = resolve(orchestratorPath, ".git");
    if (!existsSync(gitDir)) {
      console.log("Initializing git repository...");
      execSync("git init", { cwd: orchestratorPath, stdio: "pipe" });
    }

    // 2. Initialize config (creates .whs/config.json)
    console.log("Creating config...");
    initializeWhs(orchestratorPath);
    console.log(`  Created .whs/config.json`);

    // 3. Initialize beads with custom prefix
    if (!beads.isInitialized(orchestratorPath)) {
      console.log("Initializing beads...");
      beads.init(orchestratorPath, { prefix: options.prefix });
      console.log(`  Prefix: ${options.prefix}`);
    } else {
      // Update prefix on existing repo if different
      const currentPrefix = beads.getPrefix(orchestratorPath);
      if (currentPrefix !== options.prefix) {
        console.log(`Updating beads prefix to: ${options.prefix}`);
        beads.setPrefix(options.prefix, orchestratorPath);
      }
    }

    // 4. Configure sync-branch and start daemon
    console.log("Starting beads daemon...");
    try {
      beads.ensureDaemonWithSyncBranch(orchestratorPath, "beads-sync");
      console.log("  Sync branch: beads-sync");
      console.log("  Daemon started with auto-commit");
    } catch (err) {
      console.warn(`  Warning: Could not start daemon: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Set up Claude authentication
    const whsDir = resolve(orchestratorPath, ".whs");
    const authSetUp = await setupClaudeAuth(whsDir);

    console.log("\n✅ WHS initialized successfully!\n");
    console.log("Next steps:");
    if (!authSetUp) {
      console.log("  1. Set up auth:    whs claude-login");
      console.log("  2. Add a project:  whs add ~/work/myproject");
      console.log("  3. Create tasks:   bd create \"Task title\" (in project dir)");
      console.log("  4. Start working:  whs start");
    } else {
      console.log("  1. Add a project:  whs add ~/work/myproject");
      console.log("  2. Create tasks:   bd create \"Task title\" (in project dir)");
      console.log("  3. Start working:  whs start");
    }
  });

program
  .command("start")
  .description("Start the dispatcher")
  .action(async () => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    console.log(`\n🌙 While Humans Sleep ${getVersionString()}\n`);

    const config = loadConfig();

    // Ensure beads daemons are running for all projects
    console.log("Checking beads daemons...");
    for (const project of config.projects) {
      const projectPath = expandPath(project.repoPath);
      try {
        beads.ensureDaemonWithSyncBranch(projectPath, "beads-sync");
        console.log(`  ${project.name}: daemon running`);
      } catch (err) {
        console.warn(`  ${project.name}: daemon error - ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Also ensure orchestrator daemon is running
    const orchestratorPath = expandPath(config.orchestratorPath);
    try {
      beads.ensureDaemonWithSyncBranch(orchestratorPath, "beads-sync");
      console.log(`  orchestrator: daemon running`);
    } catch (err) {
      console.warn(`  orchestrator: daemon error - ${err instanceof Error ? err.message : String(err)}`);
    }

    // Check worktree hook approvals
    const { hasWtConfig, checkHookApprovals } = await import("./worktree-hooks.js");
    let hasUnapprovedHooks = false;
    const projectsWithHooks = config.projects.filter((p) => hasWtConfig(expandPath(p.repoPath)));
    if (projectsWithHooks.length > 0) {
      console.log("Checking worktree hooks...");
      for (const project of projectsWithHooks) {
        const projectPath = expandPath(project.repoPath);
        const status = checkHookApprovals(projectPath);
        if (status.allApproved) {
          console.log(`  ${project.name}: ${status.hasConfig ? "hooks approved" : "no hooks"}`);
        } else {
          hasUnapprovedHooks = true;
          console.warn(`  ${project.name}: ${status.unapprovedCount} unapproved hook(s)`);
        }
      }
      if (hasUnapprovedHooks) {
        console.warn("");
        console.warn("  ⚠  Unapproved hooks will fail when creating worktrees.");
        console.warn("  Run in each project: wt hook approvals add");
      }
    }

    console.log("");

    // Set up notifier (CLI or Telegram)
    let notifier: import("./types.js").Notifier;
    let telegramService: import("./telegram/index.js").TelegramService | null = null;

    if (config.telegram?.chatId) {
      // Load bot token from .env
      const { TelegramService, loadBotToken } = await import("./telegram/index.js");
      const botToken = loadBotToken();

      if (botToken) {
        telegramService = new TelegramService(botToken, config.telegram.chatId);
        notifier = telegramService;
        await telegramService.start();
        console.log("  Telegram bot started");
      } else {
        console.log("  Telegram configured but bot token not found in .whs/.env");
        notifier = new CLINotifier();
      }
    } else {
      // Use CLI notifier
      notifier = new CLINotifier();
      if (config.notifier === "telegram") {
        console.log("  Telegram not configured. Run `whs telegram setup` to enable.");
      }
    }

    const dispatcher = new Dispatcher(config, notifier);

    // Handle graceful shutdown (Ctrl+C or kill)
    // First signal: graceful shutdown (wait for agents)
    // Second signal: force stop
    const handleShutdown = async () => {
      await dispatcher.requestShutdown();
      if (telegramService) {
        await telegramService.stop();
        console.log("  Telegram bot stopped");
      }
      process.exit(0);
    };

    process.on("SIGINT", handleShutdown);  // Ctrl+C
    process.on("SIGTERM", handleShutdown); // kill (default signal)

    await dispatcher.start();
  });

program
  .command("restart")
  .description("Gracefully restart the dispatcher (wait for agents, then restart)")
  .action(async () => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const config = loadConfig();

    // Check if dispatcher is running
    const lockInfo = getLockInfo();
    if (!lockInfo) {
      console.log("No dispatcher running. Starting fresh...");
      // Just start normally
      const { spawn } = await import("child_process");
      const child = spawn(process.execPath, [process.argv[1], "start"], {
        detached: true,
        stdio: "inherit",
      });
      child.unref();
      return;
    }

    console.log("🔄 Restarting dispatcher...");
    console.log(`   Current PID: ${lockInfo.pid}`);
    console.log(`   Sending graceful shutdown signal...`);

    // Send SIGINT to trigger graceful shutdown
    try {
      process.kill(lockInfo.pid, "SIGINT");
    } catch (err) {
      console.error(`Failed to signal process: ${err}`);
      process.exit(1);
    }

    // Wait for process to exit
    console.log("   Waiting for shutdown...");
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes max
    while (attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        process.kill(lockInfo.pid, 0); // Check if still running
        attempts++;
        if (attempts % 10 === 0) {
          console.log(`   Still waiting... (${attempts}s)`);
        }
      } catch {
        // Process exited
        break;
      }
    }

    if (attempts >= maxAttempts) {
      console.error("   Timeout waiting for shutdown. Try `whs start` manually.");
      process.exit(1);
    }

    console.log("   Shutdown complete. Starting new dispatcher...\n");

    // Start new dispatcher (in foreground, replacing this process)
    const { spawn } = await import("child_process");
    const child = spawn(process.execPath, [process.argv[1], "start"], {
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
  });

program
  .command("stop")
  .description("Stop the dispatcher gracefully")
  .option("-f, --force", "Force immediate stop (may lose agent work)")
  .action(async (options) => {
    const lockInfo = getLockInfo();
    if (!lockInfo) {
      console.log("No dispatcher is running.");
      return;
    }

    console.log(`Stopping dispatcher (PID ${lockInfo.pid})...`);

    const signal = options.force ? "SIGKILL" : "SIGTERM";
    if (options.force) {
      console.log("  Using force stop (SIGKILL)");
    } else {
      console.log("  Using graceful shutdown (waiting for agents)");
    }

    try {
      process.kill(lockInfo.pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        console.log("  Process already exited (stale lock file).");
        return;
      }
      console.error(`  Failed to signal process: ${err}`);
      process.exit(1);
    }

    if (options.force) {
      console.log("  Dispatcher killed.");
      return;
    }

    // Wait for graceful shutdown
    console.log("  Waiting for shutdown...");
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes max
    while (attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        process.kill(lockInfo.pid, 0); // Check if still running
        attempts++;
        if (attempts % 10 === 0) {
          console.log(`  Still waiting... (${attempts}s)`);
        }
      } catch {
        // Process exited
        console.log("  Dispatcher stopped.");
        return;
      }
    }

    console.log("  Timeout. Use --force to kill immediately.");
    process.exit(1);
  });

program
  .command("add [path]")
  .description("Add a project to manage (interactive setup)")
  .option("-y, --yes", "Skip prompts and use defaults")
  .option("-n, --name <name>", "Project name")
  .option("-p, --prefix <prefix>", "Bead ID prefix")
  .option("-b, --branch <branch>", "Base branch")
  .option("-s, --stealth", "Use beads stealth mode (local only)")
  .option("-a, --agents-path <path>", "Path to agent definitions")
  .action(async (inputPath, options) => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const { createInterface } = await import("readline");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (question: string): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          resolve(answer.trim());
        });
      });
    };

    try {
      // 1. Get path (required)
      let projectPath = inputPath;
      if (!projectPath) {
        projectPath = await ask("Project path: ");
        if (!projectPath) {
          console.error("Error: Path is required.");
          process.exit(1);
        }
      }

      const resolvedPath = resolve(expandPath(projectPath));

      // Validate path exists
      if (!existsSync(resolvedPath)) {
        console.error(`Error: Path does not exist: ${resolvedPath}`);
        process.exit(1);
      }

      // Validate it's a git repository
      const gitDir = resolve(resolvedPath, ".git");
      if (!existsSync(gitDir)) {
        console.error(`Error: Not a git repository: ${resolvedPath}`);
        console.error(`Initialize git first: git init`);
        process.exit(1);
      }

      // Derive default name from folder
      const { basename } = await import("path");
      const folderName = basename(resolvedPath);

      console.log(`\n📁 Adding project from: ${resolvedPath}\n`);

      // 2. Get project name
      let name = options.name;
      if (!name && !options.yes) {
        const input = await ask(`Project name [${folderName}]: `);
        name = input || folderName;
      } else {
        name = name || folderName;
      }

      // Check if project already exists
      if (getProject(name)) {
        console.error(`Error: Project "${name}" already exists in config.`);
        console.error(`Use a different name or remove the existing project first.`);
        process.exit(1);
      }

      // 3. Get prefix
      let prefix = options.prefix;
      if (!prefix && !options.yes) {
        const input = await ask(`Bead ID prefix [${name}]: `);
        prefix = input || name;
      } else {
        prefix = prefix || name;
      }

      // 4. Get base branch
      let baseBranch = options.branch;
      if (!baseBranch) {
        // Try to detect default branch
        let defaultBranch = "main";
        try {
          const result = execSync("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo refs/heads/main", {
            cwd: resolvedPath,
            encoding: "utf-8",
          }).trim();
          defaultBranch = result.replace("refs/remotes/origin/", "").replace("refs/heads/", "");
        } catch {
          // Fallback to main
        }

        if (!options.yes) {
          const input = await ask(`Base branch [${defaultBranch}]: `);
          baseBranch = input || defaultBranch;
        } else {
          baseBranch = defaultBranch;
        }
      }

      // Validate branch exists
      try {
        execSync(`git rev-parse --verify ${baseBranch}`, {
          cwd: resolvedPath,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        console.error(`Error: Branch "${baseBranch}" does not exist in ${resolvedPath}`);
        process.exit(1);
      }

      // 5. Get beads mode
      let beadsMode: "committed" | "stealth" = options.stealth ? "stealth" : "committed";
      if (!options.stealth && !options.yes) {
        const input = await ask(`Beads mode (committed/stealth) [committed]: `);
        if (input.toLowerCase() === "stealth") {
          beadsMode = "stealth";
        }
      }

      // 6. Get agents path
      const defaultAgentsPath = "docs/llm/agents";
      let agentsPath = options.agentsPath;
      if (!agentsPath && !options.yes) {
        const input = await ask(`Agents path [${defaultAgentsPath}]: `);
        agentsPath = input || defaultAgentsPath;
      } else {
        agentsPath = agentsPath || defaultAgentsPath;
      }

      // Summary
      console.log(`\n📋 Project configuration:`);
      console.log(`   Name: ${name}`);
      console.log(`   Path: ${resolvedPath}`);
      console.log(`   Prefix: ${prefix}`);
      console.log(`   Branch: ${baseBranch}`);
      console.log(`   Beads mode: ${beadsMode}`);
      console.log(`   Agents path: ${agentsPath}`);
      console.log("");

      // Initialize beads if not present
      if (!beads.isInitialized(resolvedPath)) {
        console.log("Initializing beads...");
        try {
          beads.init(resolvedPath, { stealth: beadsMode === "stealth", prefix });
          console.log(`  ✓ Beads initialized`);
        } catch (err) {
          console.error(`Error initializing beads: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      } else {
        console.log("  ✓ Beads already initialized");
        // Update prefix if different
        const currentPrefix = beads.getPrefix(resolvedPath);
        if (currentPrefix !== prefix) {
          beads.setPrefix(prefix, resolvedPath);
          console.log(`  ✓ Updated prefix to: ${prefix}`);
        }
      }

      // Configure beads sync-branch and start daemon
      console.log("Configuring beads daemon...");
      try {
        beads.ensureDaemonWithSyncBranch(resolvedPath, "beads-sync");
        console.log("  ✓ Daemon running with sync-branch");
      } catch (err) {
        console.warn(`  ⚠ Could not start daemon: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Worktree hooks setup
      if (!options.yes) {
        const { hasWtConfig, analyzeProjectForHooks, formatHooksAsToml, writeWtConfig, gatherSiblingHooks } =
          await import("./worktree-hooks.js");

        if (!hasWtConfig(resolvedPath)) {
          console.log("");
          console.log("  Worktree Setup");
          console.log("  WHS uses git worktrees to isolate agent work. Projects often need");
          console.log("  setup hooks (dependency install, database creation, env files) to");
          console.log("  ensure each worktree is ready for agents.");
          console.log("");

          const setupHooks = await ask("  Analyze project and suggest worktree hooks? (y/N): ");
          if (setupHooks.toLowerCase() === "y" || setupHooks.toLowerCase() === "yes") {
            try {
              console.log("\n  Analyzing project...");
              const { createAgentRunner } = await import("./agent-runner-factory.js");
              const runner = createAgentRunner(loadConfig().runnerType);
              // Gather sibling project hooks as reference
              const config = loadConfig();
              const siblingHooks = gatherSiblingHooks(config.projects, resolvedPath);
              const hooks = await analyzeProjectForHooks(resolvedPath, runner, siblingHooks);
              const toml = formatHooksAsToml(hooks);

              console.log("\n  Suggested .config/wt.toml:\n");
              for (const line of toml.split("\n")) {
                console.log(`    ${line}`);
              }
              console.log("");

              const writeIt = await ask("  Write this config? (Y/n): ");
              if (writeIt.toLowerCase() !== "n" && writeIt.toLowerCase() !== "no") {
                writeWtConfig(resolvedPath, toml);
                console.log("  ✓ Written to .config/wt.toml");
              } else {
                console.log("  Skipped. Run 'whs setup hooks' later to set up hooks.");
              }
            } catch (err) {
              console.warn(`  ⚠ Hook analysis failed: ${err instanceof Error ? err.message : String(err)}`);
              console.log("  You can run 'whs setup hooks' later to set up hooks.");
            }
          } else {
            console.log("  Skipped. Run 'whs setup hooks' later to set up hooks.");
          }
        }
      }

      // Code review format setup
      if (!options.yes) {
        const {
          hasReviewFormat,
          copyReviewFormat,
          findClaudeReviewWorkflows,
          updateWorkflowReviewPrompt,
        } = await import("./review-setup.js");

        console.log("");
        console.log("  Code Review Setup");
        console.log("  WHS uses structured code review output to help the quality review");
        console.log("  agent make better routing decisions. This copies a review format");
        console.log("  template into your project and can update CI workflows.");
        console.log("");

        const setupReview = await ask("  Set up code review format? (y/N): ");
        if (setupReview.toLowerCase() === "y" || setupReview.toLowerCase() === "yes") {
          if (hasReviewFormat(resolvedPath)) {
            console.log("  ✓ docs/llm/code-review-output-format.md already exists");
          } else {
            copyReviewFormat(resolvedPath);
            console.log("  ✓ Copied docs/llm/code-review-output-format.md");
          }

          const workflows = findClaudeReviewWorkflows(resolvedPath);
          for (const workflow of workflows) {
            console.log(`\n  Found workflow: ${workflow.filename}`);
            const writeIt = await ask("  Update review prompt? (Y/n): ");
            if (writeIt.toLowerCase() !== "n" && writeIt.toLowerCase() !== "no") {
              const result = updateWorkflowReviewPrompt(workflow.path);
              if (result.updated) {
                console.log(`  ✓ Updated ${workflow.filename}`);
              } else {
                console.log(`  - ${workflow.filename}: ${result.reason}`);
              }
            }
          }
        } else {
          console.log("  Skipped. Run 'whs setup review' later to set up review format.");
        }
      }

      // Add project to config
      const added = addProject(name, resolvedPath, {
        baseBranch,
        agentsPath,
        beadsMode,
      });

      if (added) {
        console.log(`\n✅ Project "${name}" added successfully!\n`);
        console.log(`Next steps:`);
        console.log(`  1. Create tasks: cd ${resolvedPath} && bd create "Task title"`);
        console.log(`  2. Start dispatcher: whs start`);
      } else {
        console.error(`\nFailed to add project to config.`);
        process.exit(1);
      }
    } finally {
      rl.close();
    }
  });

program
  .command("remove <name>")
  .description("Remove a project from management")
  .action((name) => {
    const project = getProject(name);
    if (!project) {
      console.error(`Error: Project "${name}" not found in config.`);
      console.error(`Use "whs list" to see configured projects.`);
      process.exit(1);
    }

    const removed = removeProject(name);
    if (removed) {
      console.log(`Project "${name}" removed from config.`);
      console.log(`Note: Beads data in ${project.repoPath} was not deleted.`);
    } else {
      console.error(`Failed to remove project.`);
      process.exit(1);
    }
  });

program
  .command("plan [description]")
  .description("Start planning a new feature (interactive)")
  .option("-P, --project <name>", "Project name (default: infer from cwd)")
  .option("-p, --priority <level>", "Priority level (0-4, where 0 is critical)")
  .option("--parallel", "Allow this epic to run in parallel with existing epics")
  .action(async (inputDescription, options) => {
    const { createInterface } = await import("readline");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (question: string): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          resolve(answer.trim());
        });
      });
    };

    try {
      // 1. Determine project (from flag, cwd, or prompt)
      let projectName = options.project;
      let project = projectName ? getProject(projectName) : null;

      if (!project) {
        // Try to infer from current directory
        const cwd = process.cwd();
        const config = loadConfig();

        for (const p of config.projects) {
          const projectPath = expandPath(p.repoPath);
          if (cwd === projectPath || cwd.startsWith(projectPath + "/")) {
            project = p;
            projectName = p.name;
            break;
          }
        }
      }

      if (!project) {
        // List available projects and ask
        const projects = listProjects();
        if (projects.length === 0) {
          console.error("Error: No projects configured.");
          console.error("Run `whs add <path>` to add a project first.");
          process.exit(1);
        }

        console.log("\nAvailable projects:");
        projects.forEach((name, i) => console.log(`  ${i + 1}. ${name}`));
        console.log("");

        const input = await ask("Project name or number: ");
        const num = parseInt(input, 10);
        if (num >= 1 && num <= projects.length) {
          projectName = projects[num - 1];
        } else {
          projectName = input;
        }

        project = getProject(projectName);
        if (!project) {
          console.error(`Error: Project "${projectName}" not found.`);
          process.exit(1);
        }
      }

      console.log(`\n📋 Planning for project: ${projectName}\n`);

      // 2. Get description
      let description = inputDescription;
      if (!description) {
        description = await ask("What do you want to build? ");
        if (!description) {
          console.error("Error: Description is required.");
          process.exit(1);
        }
      }

      // 3. Get priority
      let priority = 2;
      if (options.priority !== undefined) {
        priority = parseInt(options.priority, 10);
      } else {
        const input = await ask("Priority (0=critical, 1=high, 2=normal, 3=low, 4=backlog) [2]: ");
        if (input) {
          priority = parseInt(input, 10);
          if (isNaN(priority) || priority < 0 || priority > 4) {
            console.error("Error: Priority must be 0-4.");
            process.exit(1);
          }
        }
      }

      rl.close();

      const projectPath = expandPath(project.repoPath);

      console.log(`\n📋 Creating planning workflow:`);
      console.log(`   Project: ${projectName}`);
      console.log(`   Feature: ${description}`);
      console.log(`   Priority: ${priority}`);
      console.log("");

      // Create epic in project beads (blocked status)
      const epic = beads.create(description, projectPath, {
        type: "epic",
        status: "blocked",
        priority,
        description: `Epic for: ${description}\n\nCreated via whs plan. The planning task must complete before implementation begins.`,
        labels: ["whs", "needs-planning"],
      });

      console.log(`Created epic: ${epic.id}`);
      console.log(`  Title: ${epic.title}`);
      console.log(`  Status: ${epic.status}`);

      // Chain behind existing epics (unless --parallel)
      if (!options.parallel) {
        const existingEpics = beads.list(projectPath, {
          type: "epic",
          labelAll: ["whs"],
        }).filter((b) => b.id !== epic.id && b.status !== "closed" && b.status !== "tombstone");

        if (existingEpics.length > 0) {
          // Block on the most recently created epic
          const lastEpic = existingEpics[existingEpics.length - 1];
          beads.depAdd(epic.id, lastEpic.id, projectPath);
          console.log(`  Blocked by: ${lastEpic.id} (${lastEpic.title})`);
        }
      }

      // Create planning task (open status)
      // Use label to track epic association instead of parent (to avoid dependency cycle)
      const planningTask = beads.create(`Plan: ${description}`, projectPath, {
        type: "task",
        status: "open",
        priority,
        description: `Planning task for: ${description}\n\nThis task will be picked up by the dispatcher to run the planner agent.\nThe planner will:\n1. Analyze the codebase\n2. Ask clarifying questions\n3. Create implementation subtasks\n4. Present a plan for approval`,
        labels: ["whs", "planning", "agent:planner", `epic:${epic.id}`],
      });

      console.log(`\nCreated planning task: ${planningTask.id}`);
      console.log(`  Title: ${planningTask.title}`);
      console.log(`  Epic: ${epic.id}`);
      console.log(`  Status: ${planningTask.status}`);

      // Add dependency: epic is blocked by planning task
      beads.depAdd(epic.id, planningTask.id, projectPath);
      console.log(`\nDependency added: ${epic.id} blocked by ${planningTask.id}`);

      console.log(`\n✅ Planning workflow created!\n`);
      console.log(`Next steps:`);
      console.log(`  1. Start the dispatcher: whs start`);
      console.log(`  2. The planner agent will analyze and ask questions`);
      console.log(`  3. Answer questions with: whs answer <id> "<answer>"`);
      console.log(`  4. Approve the plan when prompted`);
      console.log(`\nTrack progress: bd show ${epic.id}`);
    } catch (err) {
      rl.close();
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command("import <file>")
  .description("Import stories from a planning document")
  .option("-P, --project <name>", "Project name (inferred from cwd if omitted)")
  .option("--dry-run", "Show what would be created without creating anything")
  .option("--parallel", "Allow imported epics to run in parallel with each other and existing epics")
  .action(async (file, options) => {
    const { readFileSync } = await import("fs");
    const { parseAndValidatePlan } = await import("./plan-parser.js");

    // Determine project (from flag or infer from cwd)
    let projectName = options.project;
    let project = projectName ? getProject(projectName) : null;

    if (!project) {
      // Try to infer from current directory
      const cwd = process.cwd();
      const config = loadConfig();

      for (const p of config.projects) {
        const projectPath = expandPath(p.repoPath);
        if (cwd === projectPath || cwd.startsWith(projectPath + "/")) {
          project = p;
          projectName = p.name;
          break;
        }
      }
    }

    if (!project) {
      console.error("Error: Could not determine project");
      console.error("Either run from within a project directory or use --project <name>");
      console.error("\nAvailable projects:");
      for (const name of listProjects()) {
        console.error(`  - ${name}`);
      }
      process.exit(1);
    }

    // Read and parse the file
    const filePath = resolve(file);
    if (!existsSync(filePath)) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }

    const content = readFileSync(filePath, "utf-8");
    const plan = parseAndValidatePlan(content);

    // Report any parsing errors
    if (plan.errors.length > 0) {
      console.error("Errors in planning document:");
      for (const error of plan.errors) {
        console.error(`  - ${error}`);
      }
      process.exit(1);
    }

    if (plan.epics.length === 0) {
      console.error("Error: No epics found in document");
      console.error("Make sure your document has `# Epic: Title` headers");
      process.exit(1);
    }

    // Show what will be created
    console.log(`\n📋 Importing from: ${file}`);
    console.log(`   Project: ${projectName}`);
    console.log("");

    for (const epic of plan.epics) {
      console.log(`Epic: ${epic.title}`);
      for (const story of epic.stories) {
        const deps = story.dependsOn.length > 0 ? ` (depends on: ${story.dependsOn.join(", ")})` : "";
        console.log(`  - [P${story.priority}] ${story.title}${deps}`);
      }
      console.log("");
    }

    if (options.dryRun) {
      console.log("(dry run - nothing created)");
      return;
    }

    // Create the beads
    const projectPath = expandPath(project.repoPath);
    const createdBeads: Map<string, string> = new Map(); // title -> beadId

    // Find the last existing open epic to chain behind (unless --parallel)
    let previousEpicId: string | undefined;
    if (!options.parallel) {
      const existingEpics = beads.list(projectPath, {
        type: "epic",
        labelAll: ["whs"],
      }).filter((b) => b.status !== "closed" && b.status !== "tombstone");

      if (existingEpics.length > 0) {
        previousEpicId = existingEpics[existingEpics.length - 1].id;
      }
    }

    for (const epic of plan.epics) {
      // Create epic
      const epicBead = beads.create(epic.title, projectPath, {
        type: "epic",
        priority: 2,
        description: epic.description,
        labels: ["whs"],
      });
      console.log(`✓ Created epic: ${epicBead.id} - ${epic.title}`);

      // Chain behind previous epic (unless --parallel)
      if (!options.parallel && previousEpicId) {
        beads.depAdd(epicBead.id, previousEpicId, projectPath);
        console.log(`  → Blocked by: ${previousEpicId}`);
      }
      previousEpicId = epicBead.id;

      // Create stories
      for (const story of epic.stories) {
        const storyBead = beads.create(story.title, projectPath, {
          type: story.type,
          priority: story.priority,
          parent: epicBead.id,
          description: story.description,
          labels: ["whs"],
        });
        createdBeads.set(story.title.toLowerCase(), storyBead.id);
        console.log(`  ✓ Created ${story.type}: ${storyBead.id} - ${story.title}`);

        // Add dependencies
        for (const depTitle of story.dependsOn) {
          const depId = createdBeads.get(depTitle.toLowerCase());
          if (depId) {
            beads.depAdd(storyBead.id, depId, projectPath);
            console.log(`    → Depends on: ${depId}`);
          }
        }
      }
    }

    const totalStories = plan.epics.reduce((sum, e) => sum + e.stories.length, 0);
    console.log(`\n✅ Imported ${plan.epics.length} epic(s) with ${totalStories} stories`);
    console.log(`\nView in ${projectName}: cd ${expandPath(project.repoPath)} && bd list`);
  });

program
  .command("answer <questionId> <answer>")
  .description("Answer a pending question (dispatcher will resume agent)")
  .action(async (questionId, answer) => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const { submitAnswer } = await import("./questions.js");
    const config = loadConfig();
    const orchestratorPath = expandPath(config.orchestratorPath);

    // Get pending questions from beads
    const pendingQuestions = beads.listPendingQuestions(orchestratorPath);

    if (pendingQuestions.length === 0) {
      console.error("No pending questions.");
      process.exit(1);
    }

    // Find matching question bead
    let questionBead = pendingQuestions.find((b) => b.id === questionId);

    if (!questionBead) {
      // Try partial match
      const matches = pendingQuestions.filter((b) => b.id.includes(questionId));

      if (matches.length === 0) {
        console.error(`Error: Question "${questionId}" not found.`);
        console.error(`\nPending questions:`);
        for (const bead of pendingQuestions) {
          const data = beads.parseQuestionData(bead);
          console.error(`  ${bead.id}: ${data.questions[0]?.question || "N/A"}`);
        }
        process.exit(1);
      } else if (matches.length > 1) {
        console.error(`Error: Multiple questions match "${questionId}":`);
        for (const bead of matches) {
          console.error(`  ${bead.id}`);
        }
        console.error(`Please be more specific.`);
        process.exit(1);
      }

      questionBead = matches[0];
      questionId = questionBead.id;
    }

    // Parse question data for display
    const questionData = beads.parseQuestionData(questionBead);

    console.log(`Answering question: ${questionId}`);
    console.log(`  Project: ${questionData.metadata.project}`);
    console.log(`  Step: ${questionData.metadata.step_id}`);
    console.log(`  Question: ${questionData.questions[0]?.question || "N/A"}`);
    console.log(`  Answer: ${answer}`);
    console.log("");

    // Submit the answer (stores resume info and closes question bead)
    const result = submitAnswer(questionId, answer);

    if (!result.success) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    console.log(`✅ Answer stored for step ${result.stepId}`);
    console.log(`   The dispatcher will resume the agent on its next tick.`);
    console.log(`\n   Run 'whs status' to monitor progress.`);
  });

program
  .command("chat")
  .description("Interactive mode for answering dispatcher questions")
  .option("-i, --interval <ms>", "Poll interval when idle (ms)", "3000")
  .action(async (options) => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const { createInterface } = await import("readline");
    const {
      getOldestQuestion,
      formatQuestionForDisplay,
      submitAnswer,
    } = await import("./questions.js");

    const pollInterval = parseInt(options.interval, 10) || 3000;

    console.log("\n  While Humans Sleep - Chat Mode");
    console.log("   Watching for questions... (Ctrl+C to exit)\n");

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (prompt: string): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(prompt, (answer) => resolve(answer.trim()));
      });
    };

    // Sleep helper
    const sleep = (ms: number): Promise<void> => {
      return new Promise((resolve) => setTimeout(resolve, ms));
    };

    // Handle Ctrl+C gracefully
    let running = true;
    process.on("SIGINT", () => {
      running = false;
      console.log("\n\n   Exiting chat mode.\n");
      rl.close();
      process.exit(0);
    });

    const separator = "-".repeat(60);

    while (running) {
      const question = getOldestQuestion();

      if (!question) {
        process.stdout.write("\r   No pending questions. Waiting...  ");
        await sleep(pollInterval);
        continue;
      }

      // Clear waiting message and show question
      process.stdout.write("\r" + " ".repeat(50) + "\r");
      console.log(separator + "\n");
      console.log(formatQuestionForDisplay(question));
      console.log("");

      const answer = await ask("Your answer: ");

      if (!answer) {
        console.log("   (Skipped - no answer provided)\n");
        continue;
      }

      // Submit the answer (stores resume info and closes question bead)
      const result = submitAnswer(question.beadId, answer);

      if (!result.success) {
        console.log(`   Error: ${result.error}\n`);
        continue;
      }

      // Answer stored - dispatcher will resume the agent
      console.log(`   Answer stored for step ${result.stepId}`);
      console.log("   The dispatcher will resume the agent on its next tick.\n");

      console.log(separator + "\n");
    }

    rl.close();
  });

program
  .command("questions")
  .description("List pending questions")
  .action(() => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const config = loadConfig();
    const orchestratorPath = expandPath(config.orchestratorPath);

    const pendingQuestions = beads.listPendingQuestions(orchestratorPath);

    if (pendingQuestions.length === 0) {
      console.log("No pending questions.");
      return;
    }

    console.log(`\n❓ Pending Questions (${pendingQuestions.length})\n`);

    for (const bead of pendingQuestions) {
      const data = beads.parseQuestionData(bead);
      console.log(`  ${bead.id}`);
      console.log(`    Project: ${data.metadata.project}`);
      console.log(`    Step: ${data.metadata.step_id}`);
      console.log(`    Asked: ${data.metadata.asked_at}`);

      for (const q of data.questions) {
        console.log(`    Q: ${q.question}`);
        if (q.options && q.options.length > 0) {
          for (let i = 0; i < q.options.length; i++) {
            const opt = q.options[i];
            console.log(`       ${i + 1}. ${opt.label}${opt.description ? ` - ${opt.description}` : ""}`);
          }
        }
      }
      console.log(`    Answer with: whs answer ${bead.id} "your answer"`);
      console.log("");
    }
  });

/** Format seconds as a human-readable "Xm ago" / "Xh ago" / "Xs ago" string */
function formatSecondsAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
}

/** Format an agent log event as a single-line summary */
function formatLogEvent(event: AgentLogEvent, ago: string): string {
  switch (event.type) {
    case "start":
      return `[${ago}] ▶ Started ${event.agent || "agent"}`;
    case "tool":
      return `[${ago}] 🔧 ${event.name || "tool"}${event.input ? ": " + event.input : ""}`;
    case "text":
      return `[${ago}] 💬 ${event.text || ""}`;
    case "end":
      return `[${ago}] ✓ Completed → ${event.outcome || "unknown"}${event.cost != null ? ` ($${event.cost.toFixed(4)})` : ""}`;
    default:
      return `[${ago}] ${event.type}`;
  }
}

program
  .command("status [step]")
  .description("Show dispatcher status, or detail for a specific step")
  .option("-v, --verbose", "Show detailed information")
  .action((step, options) => {
    // Per-step detail mode
    if (step) {
      const detail = getStepDetail(step);
      if (!detail) {
        console.log(`No workflow found matching "${step}".`);
        console.log("Use 'whs status' to see all active work.");
        return;
      }

      const { work, recentActivity } = detail;
      const duration = formatDuration(work.durationMs);
      const prInfo = work.prUrl ? ` | PR #${work.prNumber}: ${work.prUrl}` : "";

      console.log(`\n📋 ${work.title}`);
      console.log(`   ${work.source} | ${work.agent} (step ${work.stepNumber}) | ${duration} | $${work.cost.toFixed(4)}${prInfo}`);

      // Show workflow status for bead-based lookups
      if (detail.workflowStatus) {
        console.log(`   Workflow: ${detail.workflowStatus}`);
      }
      console.log("");

      // Show step history for bead-based lookups
      if (detail.workflowSteps && detail.workflowSteps.length > 0) {
        console.log("   Step History:");
        for (const s of detail.workflowSteps) {
          const sDuration = formatDuration(s.durationMs);
          const outcome = s.outcome || "in progress";
          const sCost = s.cost > 0 ? ` | $${s.cost.toFixed(4)}` : "";
          console.log(`   ${s.stepId} ${s.agent} → ${outcome} (${sDuration}${sCost})`);
        }
        console.log("");
      } else if (recentActivity.length === 0) {
        console.log("   No activity logged yet.");
        console.log("");
      }

      // Show recent activity (only for live/active steps)
      if (recentActivity.length > 0) {
        console.log("   Recent Activity:");
        const now = Math.floor(Date.now() / 1000);
        for (const event of recentActivity) {
          const ago = formatSecondsAgo(now - event.t);
          console.log(`   ${formatLogEvent(event, ago)}`);
        }
        console.log("");
      }
      return;
    }

    // Overview mode
    const status = getStatusData();

    console.log(`📊 Dispatcher Status (${getVersionString()})\n`);

    // Check if dispatcher is actually running
    if (!status.running) {
      console.log("  Status: Stopped");
    } else if (status.paused) {
      console.log(`  Status: PAUSED (PID ${status.pid})`);
    } else {
      console.log(`  Status: Running (PID ${status.pid})`);
    }

    if (status.running) {
      console.log(`  Uptime: ${formatDuration(status.uptimeMs)}`);
    }

    // Active work
    console.log(`  Active work: ${status.activeWork.length}`);
    if (status.activeWork.length > 0) {
      const projects = [...new Set(status.activeWork.map((w) => w.source.split("/")[0]))];
      console.log(`  Active projects: ${projects.join(", ")}`);
    }

    // Pending questions
    console.log(`  Pending questions: ${status.questions.length}`);

    // Beads daemon status
    const config = loadConfig();
    const orchestratorPath = expandPath(config.orchestratorPath);

    console.log(`\n🔮 Beads Daemons\n`);
    let allDaemonsRunning = true;

    for (const project of config.projects) {
      const projectPath = expandPath(project.repoPath);
      const daemonStatus = beads.daemonStatus(projectPath);
      const statusIcon = daemonStatus.running ? "✓" : "✗";
      const statusText = daemonStatus.running ? `running (PID ${daemonStatus.pid})` : "stopped";
      console.log(`  ${statusIcon} ${project.name}: ${statusText}`);
      if (!daemonStatus.running) allDaemonsRunning = false;
    }

    // Orchestrator daemon
    const orchStatus = beads.daemonStatus(orchestratorPath);
    const orchIcon = orchStatus.running ? "✓" : "✗";
    const orchText = orchStatus.running ? `running (PID ${orchStatus.pid})` : "stopped";
    console.log(`  ${orchIcon} orchestrator: ${orchText}`);
    if (!orchStatus.running) allDaemonsRunning = false;

    if (!allDaemonsRunning) {
      console.log(`\n  ⚠️  Some daemons are not running. Run "whs start" to restart them.`);
    }

    // Verbose output — active work details
    if (options.verbose) {
      console.log(`\n📁 Paths\n`);
      console.log(`  Config: ${getConfigPath()}`);
      console.log(`  State: ${getStatePath()}`);
      console.log(`  Orchestrator: ${config.orchestratorPath}`);

      if (status.activeWork.length > 0) {
        console.log("\n📋 Active Work\n");
        for (const work of status.activeWork) {
          const duration = formatDuration(work.durationMs);
          const prInfo = work.prUrl ? ` | PR #${work.prNumber}: ${work.prUrl}` : "";
          console.log(`  ${work.source} — ${work.title}`);
          console.log(`    Agent: ${work.agent} (step ${work.stepNumber})`);
          console.log(`    Duration: ${duration} | Cost: $${work.cost.toFixed(4)}${prInfo}`);
        }
      }

      if (status.questions.length > 0) {
        console.log("\n❓ Pending Questions\n");
        for (const q of status.questions) {
          const suffix = q.project ? ` (${q.project})` : "";
          console.log(`  ${q.id}${suffix}`);
          console.log(`    ${q.question}`);
        }
      }
    }

    // Today's cost
    console.log(`\nToday: $${status.todayCost.toFixed(2)}`);
  });

program
  .command("pause")
  .description("Pause the dispatcher (running agents finish, no new work picked up)")
  .action(async () => {
    const lockInfo = getLockInfo();
    if (!lockInfo) {
      console.log("No dispatcher is running.");
      process.exit(1);
    }
    const state = loadState();
    if (state.paused) {
      console.log("Dispatcher is already paused.");
      return;
    }
    process.kill(lockInfo.pid, "SIGUSR1");
    console.log("Dispatcher paused. Running agents will finish, no new work picked up.");
    console.log("   Run 'whs resume' to continue.");
  });

program
  .command("resume")
  .description("Resume the dispatcher after a pause")
  .action(async () => {
    const lockInfo = getLockInfo();
    if (!lockInfo) {
      console.log("No dispatcher is running.");
      process.exit(1);
    }
    const state = loadState();
    if (!state.paused) {
      console.log("Dispatcher is not paused.");
      return;
    }
    process.kill(lockInfo.pid, "SIGUSR2");
    console.log("Dispatcher resumed.");
  });

program
  .command("retry [epic-id]")
  .description("Retry errored/blocked workflows (auto-recovers errored, or retry a specific epic)")
  .action(async (epicId: string | undefined) => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const {
      getErroredWorkflows,
      retryWorkflow,
      findEpicBySourceBead,
    } = await import("./workflow.js");

    if (epicId) {
      // Try direct epic ID first; if it fails, resolve as a source bead ID
      let resolvedEpicId = epicId;
      const epic = findEpicBySourceBead(epicId);
      if (epic) {
        resolvedEpicId = epic.id;
        console.log(`🔄 Retrying workflow: ${resolvedEpicId} (source: ${epic.sourceProject}/${epicId})`);
      } else {
        console.log(`🔄 Retrying workflow: ${epicId}`);
      }

      try {
        retryWorkflow(resolvedEpicId);
        console.log(`✅ Workflow ${resolvedEpicId} reset for retry.`);
        console.log(`   Run 'whs start' to dispatch, or it will pick up on the next tick.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      return;
    }

    // Auto mode: retry all errored workflows
    const errored = getErroredWorkflows();

    if (errored.length === 0) {
      console.log("No errored workflows to retry.");
      return;
    }

    console.log(`🔄 Retrying ${errored.length} errored workflow(s):\n`);
    for (const workflow of errored) {
      try {
        retryWorkflow(workflow.epicId);
        console.log(`  ✓ ${workflow.epicId} (${workflow.sourceProject}/${workflow.sourceBeadId}) — ${workflow.errorType}`);
      } catch (err) {
        console.error(`  ✗ ${workflow.epicId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`\nRun 'whs start' to dispatch, or it will pick up on the next tick.`);
  });

program
  .command("list")
  .description("List all configured projects")
  .action(() => {
    const projects = listProjects();

    if (projects.length === 0) {
      console.log("No projects configured.");
      console.log("Use `whs add <name> <path>` to add a project.");
      return;
    }

    console.log("Configured projects:\n");
    const config = loadConfig();
    for (const project of config.projects) {
      console.log(`  ${project.name}`);
      console.log(`    Path: ${project.repoPath}`);
      console.log(`    Branch: ${project.baseBranch}`);
      console.log(`    Beads: ${project.beadsMode}`);
      console.log("");
    }
  });

program
  .command("config")
  .description("Show configuration info")
  .action(() => {
    const config = loadConfig();
    console.log("Configuration:\n");
    console.log(`  Config file: ${getConfigPath()}`);
    console.log(`  Orchestrator: ${config.orchestratorPath}`);
    console.log(`  Max concurrent: ${config.concurrency.maxTotal}`);
    console.log(`  Max per project: ${config.concurrency.maxPerProject}`);
    console.log(`  Notifier: ${config.notifier}`);
    console.log(`  Projects: ${config.projects.length}`);
  });

// Setup subcommand
const setupCmd = program
  .command("setup")
  .description("Setup commands for project configuration");

setupCmd
  .command("hooks [project]")
  .description("Analyze project and suggest worktrunk worktree hooks")
  .option("--write", "Write config without prompting")
  .action(async (projectName: string | undefined, options: { write?: boolean }) => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const config = loadConfig();

    // Resolve project
    let project = projectName ? getProject(projectName) : null;

    if (!project) {
      if (config.projects.length === 0) {
        console.error("Error: No projects configured.");
        console.error("Run `whs add <path>` to add a project first.");
        process.exit(1);
      }

      if (config.projects.length === 1) {
        project = config.projects[0];
        projectName = project.name;
      } else {
        console.log("\nAvailable projects:");
        for (const p of config.projects) {
          console.log(`  - ${p.name}`);
        }
        console.error("\nSpecify a project: whs setup hooks <project>");
        process.exit(1);
      }
    }

    const projectPath = expandPath(project.repoPath);
    console.log(`\n  Analyzing worktree hooks for: ${projectName}`);
    console.log(`  Path: ${projectPath}\n`);

    const {
      hasWtConfig,
      analyzeProjectForHooks,
      formatHooksAsToml,
      writeWtConfig,
      gatherSiblingHooks,
    } = await import("./worktree-hooks.js");

    // Check existing config
    if (hasWtConfig(projectPath) && !options.write) {
      const { createInterface } = await import("readline");
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question("  .config/wt.toml already exists. Overwrite? (y/N): ", (ans) => {
          resolve(ans.trim());
          rl.close();
        });
      });

      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        console.log("  Cancelled.");
        return;
      }
    }

    try {
      console.log("  Running analysis...\n");
      const { createAgentRunner } = await import("./agent-runner-factory.js");
      const runner = createAgentRunner(config.runnerType);
      const siblingHooks = gatherSiblingHooks(config.projects, projectPath);
      const hooks = await analyzeProjectForHooks(projectPath, runner, siblingHooks);
      const toml = formatHooksAsToml(hooks);

      console.log("  Suggested .config/wt.toml:\n");
      for (const line of toml.split("\n")) {
        console.log(`    ${line}`);
      }
      console.log("");

      if (options.write) {
        writeWtConfig(projectPath, toml);
        console.log("  Written to .config/wt.toml\n");
        return;
      }

      const { createInterface } = await import("readline");
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question("  Write this config? (Y/n): ", (ans) => {
          resolve(ans.trim());
          rl.close();
        });
      });

      if (answer.toLowerCase() !== "n" && answer.toLowerCase() !== "no") {
        writeWtConfig(projectPath, toml);
        console.log("\n  Written to .config/wt.toml\n");
      } else {
        console.log("  Cancelled.\n");
      }
    } catch (err) {
      console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

setupCmd
  .command("review [project]")
  .description("Set up structured code review format for a project")
  .option("--write", "Write changes without prompting")
  .action(async (projectName: string | undefined, options: { write?: boolean }) => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const config = loadConfig();

    // Resolve project
    let project = projectName ? getProject(projectName) : null;

    if (!project) {
      if (config.projects.length === 0) {
        console.error("Error: No projects configured.");
        console.error("Run `whs add <path>` to add a project first.");
        process.exit(1);
      }

      if (config.projects.length === 1) {
        project = config.projects[0];
        projectName = project.name;
      } else {
        console.log("\nAvailable projects:");
        for (const p of config.projects) {
          console.log(`  - ${p.name}`);
        }
        console.error("\nSpecify a project: whs setup review <project>");
        process.exit(1);
      }
    }

    const projectPath = expandPath(project.repoPath);
    console.log(`\n  Setting up code review format for: ${projectName}`);
    console.log(`  Path: ${projectPath}\n`);

    const {
      hasReviewFormat,
      copyReviewFormat,
      findClaudeReviewWorkflows,
      updateWorkflowReviewPrompt,
      CI_REVIEW_PROMPT,
    } = await import("./review-setup.js");

    // 1. Copy review format doc
    if (hasReviewFormat(projectPath)) {
      console.log("  ✓ docs/llm/code-review-output-format.md already exists");
    } else {
      copyReviewFormat(projectPath);
      console.log("  ✓ Copied docs/llm/code-review-output-format.md");
    }

    // 2. Find and update workflows
    const workflows = findClaudeReviewWorkflows(projectPath);

    if (workflows.length === 0) {
      console.log("\n  No claude-code-action workflows found.");
      console.log("  Recommended CI review prompt:\n");
      for (const line of CI_REVIEW_PROMPT.split("\n")) {
        console.log(`    ${line}`);
      }
      console.log("");
      return;
    }

    for (const workflow of workflows) {
      console.log(`\n  Found workflow: ${workflow.filename}`);

      if (!options.write) {
        // Interactive mode — ask before updating
        const { createInterface } = await import("readline");
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>((resolve) => {
          rl.question("  Update review prompt in this workflow? (Y/n): ", (ans) => {
            resolve(ans.trim());
            rl.close();
          });
        });

        if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
          console.log("  Skipped.");
          continue;
        }
      }

      const result = updateWorkflowReviewPrompt(workflow.path);
      if (result.updated) {
        console.log(`  ✓ Updated ${workflow.filename}`);
      } else {
        console.log(`  - ${workflow.filename}: ${result.reason}`);
      }
    }

    console.log("");
  });

/**
 * Helper to save a Claude token/key to the WHS .env file
 */
async function saveClaudeAuth(
  configDir: string,
  token: string,
  isApiKey: boolean
): Promise<void> {
  const { writeFileSync, readFileSync } = await import("fs");
  const envPath = resolve(configDir, ".env");

  // Read existing .env if it exists, preserve other vars
  let existingContent = "";
  try {
    existingContent = readFileSync(envPath, "utf-8");
  } catch {
    // File doesn't exist, that's fine
  }

  // Remove any existing auth lines
  const filteredLines = existingContent
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("CLAUDE_CODE_OAUTH_TOKEN=") &&
        !line.startsWith("ANTHROPIC_API_KEY=")
    );

  // Add new token
  const varName = isApiKey ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN";
  const newContent = [
    ...filteredLines.filter((l) => l.trim()),
    "",
    "# WHS Claude Authentication",
    "# Generated by 'whs claude-login'",
    `${varName}=${token}`,
    "",
  ].join("\n");

  writeFileSync(envPath, newContent);
}

/**
 * Interactive Claude authentication setup
 * Returns true if auth was set up, false if skipped
 */
async function setupClaudeAuth(configDir: string): Promise<boolean> {
  const { spawnSync } = await import("child_process");
  const { createInterface } = await import("readline");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer.trim()));
    });
  };

  console.log("\n  Claude Authentication Setup");
  console.log("  ════════════════════════════\n");
  console.log("  WHS agents need Claude API access. Choose an option:\n");
  console.log("    1. OAuth token (uses your Claude subscription - recommended)");
  console.log("    2. API key (from console.anthropic.com - pay per use)");
  console.log("    3. Skip for now\n");

  const choice = await ask("  Your choice [1/2/3]: ");

  if (choice === "3" || choice.toLowerCase() === "skip") {
    console.log("\n  Skipped. Run 'whs claude-login' later to set up auth.\n");
    rl.close();
    return false;
  }

  if (choice === "2") {
    console.log("\n  Enter your Anthropic API key (from console.anthropic.com):");
    const apiKey = await ask("  API key: ");

    if (!apiKey || !apiKey.startsWith("sk-ant-")) {
      console.log("\n  Invalid API key. Should start with 'sk-ant-'.");
      console.log("  Run 'whs claude-login' to try again.\n");
      rl.close();
      return false;
    }

    await saveClaudeAuth(configDir, apiKey, true);
    console.log(`\n  API key saved to ${resolve(configDir, ".env")}\n`);
    rl.close();
    return true;
  }

  // OAuth flow (choice === "1" or default)
  console.log("\n  Running 'claude setup-token' to create an OAuth token...");
  console.log("  This will open a browser for authentication.\n");

  // Run claude setup-token with inherited stdio so user sees everything
  // Use command as single string to avoid deprecation warning DEP0190
  const result = spawnSync("claude setup-token", {
    stdio: "inherit",
    shell: true,
  });

  if (result.status !== 0) {
    console.log("\n  Failed to run 'claude setup-token'. Is Claude Code installed?");
    console.log("  Run 'whs claude-login' to try again.\n");
    rl.close();
    return false;
  }

  console.log("\n  Token was displayed above. Please copy it and paste here:");
  const token = await ask("  OAuth token (sk-ant-oa-...): ");

  if (!token || !token.startsWith("sk-ant-")) {
    console.log("\n  Invalid token. Should start with 'sk-ant-'.");
    console.log("  Run 'whs claude-login' to try again.\n");
    rl.close();
    return false;
  }

  await saveClaudeAuth(configDir, token, false);
  console.log(`\n  Token saved to ${resolve(configDir, ".env")}\n`);
  rl.close();
  return true;
}

program
  .command("claude-login")
  .description("Set up Claude authentication for WHS agents")
  .option("--api-key <key>", "Use an Anthropic API key instead of OAuth")
  .option("--oauth-token <token>", "Use an OAuth token directly")
  .action(async (options) => {
    const configDir = findConfigDir(process.cwd());
    if (!configDir) {
      console.error("Not in a WHS orchestrator. Run 'whs init' first.");
      process.exit(1);
    }

    // If token/key provided directly via flags, save and exit
    if (options.apiKey) {
      await saveClaudeAuth(configDir, options.apiKey, true);
      console.log(`\n  API key saved to ${resolve(configDir, ".env")}\n`);
      return;
    }

    if (options.oauthToken) {
      await saveClaudeAuth(configDir, options.oauthToken, false);
      console.log(`\n  OAuth token saved to ${resolve(configDir, ".env")}\n`);
      return;
    }

    // Interactive flow
    await setupClaudeAuth(configDir);
  });

// Telegram subcommand
const telegramCmd = program
  .command("telegram")
  .description("Telegram integration commands");

telegramCmd
  .command("setup")
  .description("Configure Telegram bot for notifications and question answering")
  .action(async () => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const { createInterface } = await import("readline");
    const { runSetupWizard } = await import("./telegram/index.js");

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (prompt: string): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(prompt, (answer) => resolve(answer.trim()));
      });
    };

    try {
      const success = await runSetupWizard(ask);
      if (!success) {
        process.exit(1);
      }
    } finally {
      rl.close();
    }
  });

telegramCmd
  .command("status")
  .description("Show Telegram integration status")
  .action(async () => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const config = loadConfig();
    const { loadBotToken } = await import("./telegram/index.js");
    const botToken = loadBotToken();

    console.log("\n  Telegram Integration Status\n");

    if (!config.telegram?.chatId) {
      console.log("  Not configured.");
      console.log("  Run 'whs telegram setup' to configure.\n");
      return;
    }

    console.log("  Configured:");
    console.log(`    Chat ID: ${config.telegram.chatId}`);
    console.log(`    Bot token: ${botToken ? "present in .whs/.env" : "MISSING from .whs/.env"}`);
    console.log(`    Notifier: ${config.notifier}`);
    console.log("");
  });

telegramCmd
  .command("disable")
  .description("Disable Telegram notifications (switch to CLI)")
  .action(async () => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const { updateConfig } = await import("./config.js");
    updateConfig({ notifier: "cli" });
    console.log("  Telegram notifications disabled. Using CLI notifier.\n");
  });

telegramCmd
  .command("enable")
  .description("Enable Telegram notifications")
  .action(async () => {
    if (!requireOrchestrator()) {
      process.exit(1);
    }

    const config = loadConfig();
    const { loadBotToken } = await import("./telegram/index.js");
    const botToken = loadBotToken();

    if (!config.telegram?.chatId || !botToken) {
      console.log("  Telegram not configured.");
      console.log("  Run 'whs telegram setup' first.\n");
      process.exit(1);
    }

    const { updateConfig } = await import("./config.js");
    updateConfig({ notifier: "telegram" });
    console.log("  Telegram notifications enabled.\n");
  });

// Handoff command (called by agents from worktrees)
program
  .command("handoff")
  .description("Record a handoff (called by agents to signal completion)")
  .requiredOption("--next-agent <agent>", "Next agent to handle this work")
  .requiredOption("--context <text>", "Summary of what was done and what the next agent needs to know")
  .option("--pr-number <number>", "PR number if one was created")
  .option("--ci-status <status>", "CI status: pending, passed, or failed")
  .action(async (options) => {
    const { writeHandoffFile, isValidAgent, HANDOFF_FILENAME } = await import("./handoff.js");

    // Validate next_agent
    if (!isValidAgent(options.nextAgent)) {
      console.error(`Error: Invalid --next-agent "${options.nextAgent}"`);
      console.error("Valid values: implementation, quality_review, release_manager, ux_specialist, architect, planner, DONE, BLOCKED");
      process.exit(1);
    }

    // Validate ci_status if provided
    if (options.ciStatus && !["pending", "passed", "failed"].includes(options.ciStatus)) {
      console.error(`Error: Invalid --ci-status "${options.ciStatus}"`);
      console.error("Valid values: pending, passed, failed");
      process.exit(1);
    }

    // Build handoff object
    const handoff: {
      next_agent: string;
      context: string;
      pr_number?: number;
      ci_status?: "pending" | "passed" | "failed";
    } = {
      next_agent: options.nextAgent,
      context: options.context,
    };

    if (options.prNumber) {
      const prNum = parseInt(options.prNumber, 10);
      if (isNaN(prNum)) {
        console.error(`Error: --pr-number must be a number, got "${options.prNumber}"`);
        process.exit(1);
      }
      handoff.pr_number = prNum;
    }

    if (options.ciStatus) {
      handoff.ci_status = options.ciStatus as "pending" | "passed" | "failed";
    }

    // Write handoff file to cwd
    writeHandoffFile(process.cwd(), handoff);
    console.log(`Handoff recorded: ${options.nextAgent}`);
    console.log(`  File: ${HANDOFF_FILENAME}`);
    console.log(`  Context: ${options.context.slice(0, 100)}${options.context.length > 100 ? "..." : ""}`);
    if (handoff.pr_number) console.log(`  PR: #${handoff.pr_number}`);
    if (handoff.ci_status) console.log(`  CI: ${handoff.ci_status}`);
  });

program.parse();
