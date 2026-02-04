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
  saveConfig,
  addProject,
  removeProject,
  getProject,
  listProjects,
  getConfigPath,
  getConfigDir,
  expandPath,
  isInitialized,
  initializeWhs,
  getDefaultOrchestratorPath,
} from "./config.js";
import { beads } from "./beads/index.js";
import {
  loadState,
  getStateSummary,
  getStatePath,
  answerQuestion as answerQuestionState,
  getPendingQuestion,
  getLockInfo,
} from "./state.js";

const program = new Command();

program
  .name("whs")
  .description("While Humans Sleep - Multi-project AI agent dispatcher")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize WHS (run once before adding projects)")
  .option("-o, --orchestrator <path>", "Orchestrator beads location", getDefaultOrchestratorPath())
  .option("-p, --prefix <prefix>", "Bead ID prefix for orchestrator", "orc")
  .action(async (options) => {
    // Check if already initialized
    if (isInitialized()) {
      console.log("WHS is already initialized.");
      console.log(`  Config: ${getConfigPath()}`);
      const config = loadConfig();
      console.log(`  Orchestrator: ${config.orchestratorPath}`);
      console.log("");
      console.log("Use `whs add <name> <path>` to add projects.");
      return;
    }

    const orchestratorPath = expandPath(options.orchestrator);

    console.log("🌙 Initializing While Humans Sleep\n");
    console.log(`  Config directory: ${getConfigDir()}`);
    console.log(`  Orchestrator: ${orchestratorPath}`);
    console.log("");

    // 1. Initialize config
    console.log("Creating config...");
    const config = initializeWhs(orchestratorPath);
    console.log(`  Created ${getConfigPath()}`);

    // 2. Create orchestrator directory
    if (!existsSync(orchestratorPath)) {
      console.log("Creating orchestrator directory...");
      mkdirSync(orchestratorPath, { recursive: true });
    }

    // 3. Initialize git repo
    const gitDir = resolve(orchestratorPath, ".git");
    if (!existsSync(gitDir)) {
      console.log("Initializing git repository...");
      execSync("git init", { cwd: orchestratorPath, stdio: "pipe" });
    }

    // 4. Initialize beads with custom prefix
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

    // 5. Configure sync-branch and start daemon
    console.log("Starting beads daemon...");
    try {
      beads.ensureDaemonWithSyncBranch(orchestratorPath, "beads-sync");
      console.log("  Sync branch: beads-sync");
      console.log("  Daemon started with auto-commit");
    } catch (err) {
      console.warn(`  Warning: Could not start daemon: ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log("\n✅ WHS initialized successfully!\n");
    console.log("Next steps:");
    console.log("  1. Add a project:  whs add myproject ~/work/myproject");
    console.log("  2. Create tasks:   bd create \"Task title\" (in project dir)");
    console.log("  3. Start working:  whs start");
  });

program
  .command("start")
  .description("Start the dispatcher")
  .action(async () => {
    // Check if WHS is initialized
    if (!isInitialized()) {
      console.error("Error: WHS is not initialized.");
      console.error("Run `whs init` first to set up the orchestrator.");
      process.exit(1);
    }

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

    console.log("");

    const notifier = new CLINotifier();
    const dispatcher = new Dispatcher(config, notifier);

    // Handle graceful shutdown (Ctrl+C or kill)
    // First signal: graceful shutdown (wait for agents)
    // Second signal: force stop
    const handleShutdown = async () => {
      await dispatcher.requestShutdown();
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
    // Check if WHS is initialized
    if (!isInitialized()) {
      console.error("Error: WHS is not initialized.");
      console.error("Run `whs init` first to set up the orchestrator.");
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
    // Check if WHS is initialized
    if (!isInitialized()) {
      console.error("Error: WHS is not initialized.");
      console.error("Run `whs init` first to set up the orchestrator.");
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

      rl.close();

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

      // Create planning task under the epic (open status)
      // Use type "task" with label "planning" since beads doesn't have a planning type
      const planningTask = beads.create(`Plan: ${description}`, projectPath, {
        type: "task",
        status: "open",
        priority,
        parent: epic.id,
        description: `Planning task for: ${description}\n\nThis task will be picked up by the dispatcher to run the planner agent.\nThe planner will:\n1. Analyze the codebase\n2. Ask clarifying questions\n3. Create implementation subtasks\n4. Present a plan for approval`,
        labels: ["whs", "planning", "agent:planner"],
      });

      console.log(`\nCreated planning task: ${planningTask.id}`);
      console.log(`  Title: ${planningTask.title}`);
      console.log(`  Parent: ${epic.id}`);
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
  .command("answer <questionId> <answer>")
  .description("Answer a pending question")
  .action(async (questionId, answer) => {
    // Load current state
    const state = loadState();

    // Find the pending question
    const question = getPendingQuestion(state, questionId);
    if (!question) {
      // Try to find partial match
      const allIds = [...state.pendingQuestions.keys()];
      const matches = allIds.filter((id) => id.includes(questionId));

      if (matches.length === 0) {
        console.error(`Error: Question "${questionId}" not found.`);
        if (state.pendingQuestions.size === 0) {
          console.error(`No pending questions.`);
        } else {
          console.error(`\nPending questions:`);
          for (const [id, q] of state.pendingQuestions) {
            console.error(`  ${id}: ${q.questions[0]?.question || "N/A"}`);
          }
        }
        process.exit(1);
      } else if (matches.length > 1) {
        console.error(`Error: Multiple questions match "${questionId}":`);
        for (const id of matches) {
          console.error(`  ${id}`);
        }
        console.error(`Please be more specific.`);
        process.exit(1);
      }
      // Single match found, use it
      questionId = matches[0];
    }

    // Get the question details for display
    const pendingQuestion = state.pendingQuestions.get(questionId)!;

    console.log(`Answering question: ${questionId}`);
    console.log(`  Project: ${pendingQuestion.project}`);
    console.log(`  Work item: ${pendingQuestion.workItemId}`);
    console.log(`  Question: ${pendingQuestion.questions[0]?.question || "N/A"}`);
    console.log(`  Answer: ${answer}`);
    console.log("");

    try {
      // Store the answer in state
      answerQuestionState(state, questionId, answer);

      console.log(`Answer recorded.`);
      console.log(`\nThe dispatcher will process this answer on its next tick.`);
      console.log(`If the dispatcher is not running, start it with: whs start`);
    } catch (err) {
      console.error(`Error recording answer: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show dispatcher status")
  .option("-v, --verbose", "Show detailed information")
  .action((options) => {
    const config = loadConfig();
    const state = loadState();
    const summary = getStateSummary(state);
    const lockInfo = getLockInfo();

    console.log("📊 Dispatcher Status\n");

    // Check if dispatcher is actually running
    if (!lockInfo) {
      console.log("  Status: Stopped");
    } else if (summary.paused) {
      console.log(`  Status: PAUSED (PID ${lockInfo.pid})`);
    } else {
      console.log(`  Status: Running (PID ${lockInfo.pid})`);
    }

    // Active work
    console.log(`  Active work: ${summary.activeWorkCount}`);
    if (summary.activeWorkCount > 0) {
      console.log(`  Active projects: ${summary.activeProjects.join(", ")}`);
      if (summary.oldestWork) {
        const elapsed = Date.now() - summary.oldestWork.getTime();
        const minutes = Math.floor(elapsed / 60000);
        console.log(`  Oldest work: ${minutes} minutes ago`);
      }
    }

    // Pending questions
    console.log(`  Pending questions: ${summary.pendingQuestionsCount}`);

    // Beads daemon status
    console.log(`\n🔮 Beads Daemons\n`);
    let allDaemonsRunning = true;

    for (const project of config.projects) {
      const projectPath = expandPath(project.repoPath);
      const status = beads.daemonStatus(projectPath);
      const statusIcon = status.running ? "✓" : "✗";
      const statusText = status.running ? `running (PID ${status.pid})` : "stopped";
      console.log(`  ${statusIcon} ${project.name}: ${statusText}`);
      if (!status.running) allDaemonsRunning = false;
    }

    // Orchestrator daemon
    const orchestratorPath = expandPath(config.orchestratorPath);
    const orchStatus = beads.daemonStatus(orchestratorPath);
    const orchIcon = orchStatus.running ? "✓" : "✗";
    const orchText = orchStatus.running ? `running (PID ${orchStatus.pid})` : "stopped";
    console.log(`  ${orchIcon} orchestrator: ${orchText}`);
    if (!orchStatus.running) allDaemonsRunning = false;

    if (!allDaemonsRunning) {
      console.log(`\n  ⚠️  Some daemons are not running. Run "whs start" to restart them.`);
    }

    // Verbose output
    if (options.verbose) {
      console.log(`\n📁 Paths\n`);
      console.log(`  Config: ${getConfigPath()}`);
      console.log(`  State: ${getStatePath()}`);
      console.log(`  Orchestrator: ${config.orchestratorPath}`);
      console.log(`  Last updated: ${state.lastUpdated.toISOString()}`);

      if (state.activeWork.size > 0) {
        console.log("\n📋 Active Work\n");
        for (const [id, work] of state.activeWork) {
          const elapsed = Math.floor((Date.now() - work.startedAt.getTime()) / 60000);
          console.log(`  ${id} (${work.workItem.project})`);
          console.log(`    Agent: ${work.agent}`);
          console.log(`    Duration: ${elapsed} min`);
          console.log(`    Cost: $${work.costSoFar.toFixed(4)}`);
        }
      }

      if (state.pendingQuestions.size > 0) {
        console.log("\n❓ Pending Questions\n");
        for (const [id, question] of state.pendingQuestions) {
          console.log(`  ${id} (${question.project})`);
          console.log(`    Work item: ${question.workItemId}`);
          console.log(`    Question: ${question.questions[0]?.question || "N/A"}`);
          console.log(`    Asked: ${question.askedAt.toISOString()}`);
        }
      }
    }
  });

program
  .command("pause")
  .description("Pause the dispatcher")
  .action(async () => {
    // TODO: Signal running dispatcher to pause
    console.log("⚠️  Not implemented yet");
  });

program
  .command("resume")
  .description("Resume the dispatcher")
  .action(async () => {
    // TODO: Signal running dispatcher to resume
    console.log("⚠️  Not implemented yet");
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

program.parse();
