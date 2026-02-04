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
  expandPath,
} from "./config.js";
import { beads } from "./beads/index.js";
import {
  loadState,
  getStateSummary,
  getStatePath,
  answerQuestion as answerQuestionState,
  getPendingQuestion,
} from "./state.js";

const program = new Command();

program
  .name("whs")
  .description("While Humans Sleep - Multi-project AI agent dispatcher")
  .version("0.1.0");

program
  .command("start")
  .description("Start the dispatcher")
  .action(async () => {
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

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      await dispatcher.stop();
      process.exit(0);
    });

    await dispatcher.start();
  });

program
  .command("add <name> <path>")
  .description("Add a project to manage")
  .option("-b, --branch <branch>", "Base branch", "main")
  .option("-s, --stealth", "Use beads stealth mode (local only)")
  .option("-a, --agents-path <path>", "Path to agent definitions", "docs/llm/agents")
  .action(async (name, projectPath, options) => {
    const beadsMode = options.stealth ? "stealth" : "committed";

    // Expand and resolve the path
    const resolvedPath = resolve(expandPath(projectPath));

    console.log(`Adding project: ${name}`);
    console.log(`  Path: ${resolvedPath}`);
    console.log(`  Branch: ${options.branch}`);
    console.log(`  Beads mode: ${beadsMode}`);
    console.log(`  Agents path: ${options.agentsPath}`);
    console.log("");

    // 1. Check if project already exists in config
    if (getProject(name)) {
      console.error(`Error: Project "${name}" already exists in config.`);
      console.error(`Use a different name or remove the existing project first.`);
      process.exit(1);
    }

    // 2. Validate path exists
    if (!existsSync(resolvedPath)) {
      console.error(`Error: Path does not exist: ${resolvedPath}`);
      process.exit(1);
    }

    // 3. Validate it's a git repository
    const gitDir = resolve(resolvedPath, ".git");
    if (!existsSync(gitDir)) {
      console.error(`Error: Not a git repository: ${resolvedPath}`);
      console.error(`Initialize git first: git init`);
      process.exit(1);
    }

    // 4. Validate base branch exists
    try {
      execSync(`git rev-parse --verify ${options.branch}`, {
        cwd: resolvedPath,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      console.error(`Error: Branch "${options.branch}" does not exist in ${resolvedPath}`);
      console.error(`Create it first or specify a different branch with --branch`);
      process.exit(1);
    }

    // 5. Initialize beads if not present
    if (!beads.isInitialized(resolvedPath)) {
      console.log("Initializing beads...");
      try {
        beads.init(resolvedPath, options.stealth);
        console.log(`  Beads initialized (${beadsMode} mode)`);
      } catch (err) {
        console.error(`Error initializing beads: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    } else {
      console.log("  Beads already initialized");
    }

    // 6. Ensure orchestrator beads repo exists
    const config = loadConfig();
    const orchestratorPath = expandPath(config.orchestratorPath);

    if (!existsSync(orchestratorPath)) {
      console.log(`Creating orchestrator directory: ${orchestratorPath}`);
      mkdirSync(orchestratorPath, { recursive: true });

      // Initialize as git repo
      execSync("git init", { cwd: orchestratorPath, stdio: "pipe" });
      console.log("  Git repository initialized");

      // Initialize beads in orchestrator (always committed mode)
      beads.init(orchestratorPath, false);
      console.log("  Beads initialized in orchestrator");
    } else if (!beads.isInitialized(orchestratorPath)) {
      // Orchestrator dir exists but beads not initialized
      if (!existsSync(resolve(orchestratorPath, ".git"))) {
        execSync("git init", { cwd: orchestratorPath, stdio: "pipe" });
        console.log("  Git repository initialized in orchestrator");
      }
      beads.init(orchestratorPath, false);
      console.log("  Beads initialized in orchestrator");
    }

    // 7. Configure beads sync-branch and start daemon
    // This ensures beads commits go to a separate branch, keeping main clean for PR merges
    console.log("Configuring beads daemon...");
    try {
      beads.ensureDaemonWithSyncBranch(resolvedPath, "beads-sync");
      console.log("  Sync branch: beads-sync");
      console.log("  Daemon started with auto-commit");
    } catch (err) {
      console.warn(`  Warning: Could not start beads daemon: ${err instanceof Error ? err.message : String(err)}`);
      console.warn("  You may need to start it manually: bd daemon start --auto-commit");
    }

    // 8. Also configure daemon for orchestrator
    try {
      beads.ensureDaemonWithSyncBranch(orchestratorPath, "beads-sync");
      console.log("  Orchestrator daemon configured");
    } catch (err) {
      console.warn(`  Warning: Could not start orchestrator daemon: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 9. Add project to config
    const added = addProject(name, resolvedPath, {
      baseBranch: options.branch,
      agentsPath: options.agentsPath,
      beadsMode,
    });

    if (added) {
      console.log(`\nProject "${name}" added successfully.`);
      console.log(`\nNext steps:`);
      console.log(`  1. Create tasks with: bd create "Task title" (in ${resolvedPath})`);
      console.log(`  2. Start the dispatcher with: whs start`);
    } else {
      console.error(`\nFailed to add project to config.`);
      process.exit(1);
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
  .command("plan <project> <description>")
  .description("Start planning a new feature")
  .option("-p, --priority <level>", "Priority level (0-4, where 0 is critical)", "2")
  .action(async (projectName, description, options) => {
    // 1. Validate project exists
    const project = getProject(projectName);
    if (!project) {
      console.error(`Error: Project "${projectName}" not found in config.`);
      console.error(`Use "whs list" to see configured projects.`);
      process.exit(1);
    }

    const projectPath = expandPath(project.repoPath);
    const priority = parseInt(options.priority, 10);

    console.log(`Planning new feature for ${projectName}`);
    console.log(`  Description: ${description}`);
    console.log(`  Priority: ${priority}`);
    console.log("");

    try {
      // 2. Create epic in project beads (blocked status)
      // The epic represents the feature to be built
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

      // 3. Create planning task under the epic (open status)
      // This task will be picked up by the dispatcher and run the planner agent
      const planningTask = beads.create(`Plan: ${description}`, projectPath, {
        type: "planning",
        status: "open",
        priority,
        parent: epic.id,
        description: `Planning task for: ${description}\n\nThis task will be picked up by the dispatcher to run the planner agent.\nThe planner will:\n1. Analyze the codebase\n2. Ask clarifying questions\n3. Create implementation subtasks\n4. Present a plan for approval`,
        labels: ["whs", "agent:planner"],
      });

      console.log(`\nCreated planning task: ${planningTask.id}`);
      console.log(`  Title: ${planningTask.title}`);
      console.log(`  Parent: ${epic.id}`);
      console.log(`  Status: ${planningTask.status}`);

      // 4. Add dependency: epic is blocked by planning task
      beads.depAdd(epic.id, planningTask.id, projectPath);
      console.log(`\nDependency added: ${epic.id} blocked by ${planningTask.id}`);

      console.log(`\nPlanning workflow created successfully.`);
      console.log(`\nNext steps:`);
      console.log(`  1. Start the dispatcher: whs start`);
      console.log(`  2. The planner agent will analyze and ask questions`);
      console.log(`  3. Answer questions with: whs answer <id> "<answer>"`);
      console.log(`  4. Approve the plan when prompted`);
      console.log(`\nTrack progress: bd show ${epic.id} (in ${projectPath})`);
    } catch (err) {
      console.error(`Error creating planning workflow: ${err instanceof Error ? err.message : String(err)}`);
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

    console.log("📊 Dispatcher Status\n");

    // Paused state
    if (summary.paused) {
      console.log("  Status: PAUSED");
    } else {
      console.log("  Status: Running");
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
