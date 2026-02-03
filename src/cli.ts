#!/usr/bin/env node

/**
 * While Humans Sleep - CLI
 */

import { Command } from "commander";
import { Dispatcher } from "./dispatcher.js";
import { CLINotifier } from "./notifiers/cli.js";
import type { Config } from "./types.js";

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
  .action(async (name, path, options) => {
    console.log(`Adding project: ${name}`);
    console.log(`  Path: ${path}`);
    console.log(`  Branch: ${options.branch}`);
    console.log(`  Beads mode: ${options.stealth ? "stealth" : "committed"}`);

    // TODO:
    // 1. Validate path exists
    // 2. Initialize beads if not present
    // 3. Add to config
    console.log("\n⚠️  Not implemented yet");
  });

program
  .command("plan <project> <description>")
  .description("Start planning a new feature")
  .action(async (project, description) => {
    console.log(`Planning: ${description}`);
    console.log(`  Project: ${project}`);

    // TODO:
    // 1. Create epic in project beads
    // 2. Create planning task
    // 3. Dispatcher will pick it up
    console.log("\n⚠️  Not implemented yet");
  });

program
  .command("answer <questionId> <answer>")
  .description("Answer a pending question")
  .action(async (questionId, answer) => {
    console.log(`Answering: ${questionId}`);
    console.log(`  Answer: ${answer}`);

    // TODO: Load dispatcher state and call answerQuestion
    console.log("\n⚠️  Not implemented yet");
  });

program
  .command("status")
  .description("Show dispatcher status")
  .action(async () => {
    console.log("📊 Dispatcher Status\n");

    // TODO: Load state and show active work, pending questions
    console.log("⚠️  Not implemented yet");
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

program.parse();

// === Helpers ===

function loadConfig(): Config {
  // TODO: Load from ~/.whs/config.json or local config
  // For now, return defaults
  return {
    projects: [],
    orchestratorPath: expandPath("~/work/whs-orchestrator"),
    concurrency: {
      maxTotal: 4,
      maxPerProject: 2,
    },
    notifier: "cli",
  };
}

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", process.env.HOME || "");
  }
  return path;
}
