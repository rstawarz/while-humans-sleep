/**
 * Main Dispatcher - orchestrates agent work across projects
 *
 * The dispatcher is the heart of While Humans Sleep. It:
 * 1. Polls project beads for new work
 * 2. Creates workflow epics in the orchestrator
 * 3. Dispatches agents to worktrees
 * 4. Handles handoffs between agents
 * 5. Manages questions and crash recovery
 */

import type {
  Config,
  Project,
  WorkItem,
  ActiveWork,
  QuestionBeadData,
  Notifier,
} from "./types.js";
import { beads } from "./beads/index.js";
import { expandPath, loadConfig } from "./config.js";
import {
  loadState,
  saveState,
  addActiveWork,
  removeActiveWork,
  updateActiveWork,
  setPaused,
  acquireLock,
  releaseLock,
  getLockInfo,
  type DispatcherState,
} from "./state.js";
import {
  startWorkflow,
  createNextStep,
  completeStep,
  completeWorkflow,
  getWorkflowContext,
  getWorkflowEpic,
  getReadyWorkflowSteps as getReadySteps,
  getSourceBeadInfo,
  getFirstAgent,
  markStepInProgress,
  markStepOpen,
  resetStepForRetry,
  getWorkflowForSource,
  getStepResumeInfo,
  clearStepResumeInfo,
  getStepsPendingCI,
  updateStepCIStatus,
  epicHasLabel,
  addEpicLabel,
  errorWorkflow,
  getErroredWorkflows,
  retryWorkflow,
} from "./workflow.js";
import { execSync } from "child_process";
import { ensureWorktree, removeWorktree, listWorktrees } from "./worktree.js";
import { formatAgentPrompt, type AgentRunner } from "./agent-runner.js";
import { createAgentRunner } from "./agent-runner-factory.js";
import { getHandoff, isValidAgent } from "./handoff.js";
import {
  recordWorkflowStart,
  recordWorkflowComplete,
  recordStepStart,
  recordStepComplete,
  getTodayCost,
} from "./metrics.js";
import { logAgentEvent, cleanAllLogs } from "./agent-log.js";
import type { Bead } from "./beads/types.js";
import type { Logger } from "./logger.js";
import { ConsoleLogger } from "./logger.js";

export class Dispatcher {
  private projects: Map<string, Project>;
  private state: DispatcherState;
  private notifier: Notifier;
  private logger: Logger;
  private lastOperation: string = "idle";
  private agentRunner: AgentRunner;
  private running: boolean = false;
  private shuttingDown: boolean = false;
  private preflightNeeded: boolean = false;
  private tickCount: number = 0;
  private runningAgents: Map<string, Promise<void>> = new Map();
  private shutdownResolve: (() => void) | null = null;
  private readonly startedAt: Date = new Date();

  private readonly config: Config;

  // Check daemon health every 60 ticks (5 min at 5s intervals)
  private readonly DAEMON_HEALTH_CHECK_INTERVAL = 60;
  // Graceful shutdown timeout (wait for agents)
  private readonly GRACEFUL_SHUTDOWN_TIMEOUT_MS = 300000; // 5 minutes
  // Max dispatch attempts before circuit breaker trips
  private readonly MAX_DISPATCH_ATTEMPTS = 3;
  // Max agent turns — if agent uses this many, it likely hit the limit
  private readonly MAX_AGENT_TURNS = 500;

  constructor(config: Config, notifier: Notifier, agentRunner?: AgentRunner, logger?: Logger) {
    this.config = config;
    this.projects = new Map(config.projects.map((p) => [p.name, p]));
    this.notifier = notifier;
    this.logger = logger ?? new ConsoleLogger();
    this.agentRunner = agentRunner ?? createAgentRunner(config.runnerType);

    // Load persisted state for crash recovery
    this.state = loadState();
  }

  async start(): Promise<void> {
    // Check if another dispatcher is already running
    const existingLock = getLockInfo();
    if (existingLock) {
      this.logger.error("❌ Another dispatcher is already running!");
      this.logger.error(`   PID: ${existingLock.pid}`);
      this.logger.error(`   Started: ${existingLock.startedAt}`);
      this.logger.error("");
      this.logger.error("Use `whs status` to check its status, or kill the process manually.");
      throw new Error("Dispatcher already running");
    }

    // Acquire lock
    if (!acquireLock()) {
      this.logger.error("❌ Failed to acquire dispatcher lock");
      throw new Error("Failed to acquire lock");
    }

    // Only intercept raw stdout/stderr when using ConsoleLogger.
    // In TUI mode, ink owns stdout for rendering — intercepting it
    // breaks ink's cursor management and causes duplicate panels.
    if (this.logger instanceof ConsoleLogger) {
      this.setupOutputInterceptor();
    }

    // Clean up agent logs from previous session
    cleanAllLogs();

    this.logger.log("🌙 While Humans Sleep - Starting dispatcher");
    this.logger.log(`   PID: ${process.pid}`);
    this.logger.log(`   Projects: ${[...this.projects.keys()].join(", ") || "(none)"}`);
    this.logger.log(`   Max concurrent: ${this.config.concurrency.maxTotal}`);
    this.logger.log(`   Orchestrator: ${this.config.orchestratorPath}`);

    if (this.state.activeWork.size > 0) {
      this.logger.log(`   Recovering: ${this.state.activeWork.size} active work items`);
    }
    // Check for pending questions in orchestrator beads
    const orchestratorPath = expandPath(this.config.orchestratorPath);
    const pendingQuestions = beads.listPendingQuestions(orchestratorPath);
    if (pendingQuestions.length > 0) {
      this.logger.log(`   Pending questions: ${pendingQuestions.length}`);
    }
    this.logger.log("");

    // Verify agent auth/connectivity before starting the tick loop
    try {
      await this.runPreflightCheck();
    } catch (err) {
      releaseLock();
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("auth")) {
        this.logger.error("\n" + "=".repeat(60));
        this.logger.error("🔐 PREFLIGHT FAILED — AUTHENTICATION ERROR");
        this.logger.error("=".repeat(60));
        this.logger.error(`\nError: ${message}`);
        this.logger.error("\nPlease fix authentication before starting:");
        this.logger.error("  1. Run 'whs claude-login' to refresh OAuth token, or");
        this.logger.error("  2. Set ANTHROPIC_API_KEY in ~/work/whs-orchestrator/.whs/.env");
        this.logger.error("=".repeat(60) + "\n");
      } else {
        this.logger.error(`\n❌ Preflight check failed: ${message}`);
        this.logger.error("   The dispatcher cannot start without a working agent connection.\n");
      }
      throw err;
    }

    if (this.state.paused) {
      this.logger.log("⚠️  Dispatcher is PAUSED (from previous session). Run 'whs resume' to start processing.");
    }

    // Recover any workflows that were marked errored (e.g., auth failures)
    // Now that preflight passed, these can be retried
    this.recoverErroredWorkflows();

    this.running = true;

    // Pause/resume signal handlers (used by `whs pause` and `whs resume`)
    const onPause = (): void => { this.pause(); };
    const onResume = (): void => { this.resume(); };
    process.on("SIGUSR1", onPause);
    process.on("SIGUSR2", onResume);

    while (this.running) {
      // Run preflight check after resume before first tick
      if (this.preflightNeeded) {
        this.preflightNeeded = false;
        try {
          await this.runPreflightCheck();
          this.recoverErroredWorkflows();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`❌ Preflight check failed after resume: ${message}`);
          this.pause();
          await this.notifier.notifyRateLimit(
            new Error(`Preflight check failed: ${message}`)
          );
          await this.sleep(5000);
          continue;
        }
      }

      if (!this.state.paused) {
        try {
          await this.tick();
          this.tickCount++;

          // Periodic maintenance (every ~5 min)
          if (this.tickCount % this.DAEMON_HEALTH_CHECK_INTERVAL === 0) {
            await this.checkDaemonHealth();
            this.cleanupMergedWorktrees();
          }
        } catch (err) {
          this.logger.error(`Error in dispatcher tick: ${err}`);
        }
      }
      await this.sleep(5000);
    }
  }

  /**
   * Request graceful shutdown - waits for running agents to complete
   */
  async requestShutdown(): Promise<void> {
    if (this.shuttingDown) {
      // Already shutting down, force stop
      this.logger.log("\n⚠️  Force stopping (agents may lose work)...");
      this.stopDispatcher(true);
      return;
    }

    this.shuttingDown = true;
    const activeCount = this.runningAgents.size;

    if (activeCount === 0) {
      this.logger.log("\n🛑 No active agents, stopping immediately...");
      this.stopDispatcher(false);
      return;
    }

    this.logger.log(`\n🛑 Graceful shutdown requested...`);
    this.logger.log(`   Waiting for ${activeCount} active agent(s) to complete.`);
    this.logger.log(`   Press Ctrl+C again to force stop.\n`);

    // Wait for all running agents with timeout
    const agentPromises = [...this.runningAgents.values()];
    const agentsFinished = Promise.all(agentPromises).then(() => "agents-done" as const);
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        this.logger.log("\n⏰ Graceful shutdown timeout reached.");
        resolve("timeout");
      }, this.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    });

    // Create a promise that resolves when shutdown is forced (second Ctrl+C)
    const forcePromise = new Promise<"forced">((resolve) => {
      this.shutdownResolve = () => resolve("forced");
    });

    const reason = await Promise.race([
      agentsFinished,
      timeoutPromise,
      forcePromise,
    ]);

    if (reason === "agents-done") {
      this.logger.log("\n✅ All agents completed. Shutting down.");
    }

    // Only abort agents if they didn't finish gracefully
    this.stopDispatcher(reason !== "agents-done");
  }

  /**
   * Stop the dispatcher, optionally aborting running agents.
   */
  private stopDispatcher(abortAgents: boolean): void {
    this.logger.log("🛑 Stopping dispatcher...");
    this.running = false;

    // Remove signal handlers
    process.removeAllListeners("SIGUSR1");
    process.removeAllListeners("SIGUSR2");

    // Only abort agents if they didn't finish gracefully
    if (abortAgents && this.runningAgents.size > 0) {
      this.logger.log(`   Aborting ${this.runningAgents.size} running agent(s)...`);
      this.agentRunner.abort();
    }

    saveState(this.state);
    releaseLock();
    if (this.shutdownResolve) {
      this.shutdownResolve();
    }
  }

  /**
   * Check if dispatcher is accepting new work
   */
  isAcceptingWork(): boolean {
    return this.running && !this.shuttingDown;
  }

  /**
   * Get count of running agents
   */
  getRunningAgentCount(): number {
    return this.runningAgents.size;
  }

  /**
   * Legacy stop method - now calls requestShutdown
   */
  async stop(): Promise<void> {
    await this.requestShutdown();
  }

  pause(): void {
    this.state = setPaused(this.state, true);
    this.logger.log("⏸️  Dispatcher paused");
  }

  resume(): void {
    this.preflightNeeded = true;
    this.state = setPaused(this.state, false);
    this.logger.log("▶️  Dispatcher resumed (preflight pending)");
  }

  /**
   * Installs an interceptor on stdout/stderr to detect unexpected output.
   *
   * All WHS output goes through console.log/console.error which we control.
   * Any output that doesn't originate from our code is suspicious and gets
   * tagged with the last known operation for debugging.
   *
   * This is diagnostic tooling to track down the "no git remotes found"
   * mystery message (and any future similar issues).
   */
  private setupOutputInterceptor(): void {
    const self = this;
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    // Track whether we're inside a console.log/error call
    let insideConsole = false;
    const origConsoleLog = console.log;
    const origConsoleError = console.error;
    const origConsoleWarn = console.warn;

    console.log = (...args: unknown[]) => {
      insideConsole = true;
      origConsoleLog(...args);
      insideConsole = false;
    };
    console.error = (...args: unknown[]) => {
      insideConsole = true;
      origConsoleError(...args);
      insideConsole = false;
    };
    console.warn = (...args: unknown[]) => {
      insideConsole = true;
      origConsoleWarn(...args);
      insideConsole = false;
    };

    function interceptWrite(
      stream: "stdout" | "stderr",
      origWrite: typeof process.stdout.write
    ): typeof process.stdout.write {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = function (chunk: any, encodingOrCb?: any, cb?: any): boolean {
        if (!insideConsole) {
          const text = typeof chunk === "string" ? chunk : chunk.toString();
          const trimmed = text.trim();
          if (trimmed.length > 0) {
            // Use origStderrWrite directly to avoid recursion — origConsoleWarn
            // would write to the wrapped stderr, causing infinite recursion.
            const msg = `[WHS:INTERCEPTED] ${stream}: "${trimmed}" (during: ${self.lastOperation})\n`;
            origStderrWrite.call(process.stderr, msg);
          }
        }
        return origWrite.call(process[stream], chunk, encodingOrCb, cb);
      };
      return wrapped as typeof process.stdout.write;
    }

    process.stdout.write = interceptWrite("stdout", origStdoutWrite);
    process.stderr.write = interceptWrite("stderr", origStderrWrite);
  }

  /**
   * Runs a minimal agent invocation to verify auth/connectivity.
   *
   * Called before the tick loop on start(), and after resume() before the
   * first tick. Throws on failure — caller decides how to handle it.
   */
  async runPreflightCheck(): Promise<void> {
    this.logger.log("🔍 Running preflight check...");

    const orchestratorPath = expandPath(this.config.orchestratorPath);

    const result = await this.agentRunner.run({
      prompt: "Respond with exactly: PREFLIGHT_OK",
      cwd: orchestratorPath,
      maxTurns: 1,
    });

    if (result.isAuthError) {
      throw new Error(`Authentication failed: ${result.error || "unknown auth error"}`);
    }

    if (!result.success) {
      throw new Error(`Preflight check failed: ${result.error || "agent returned unsuccessful result"}`);
    }

    this.logger.log("✅ Preflight check passed");
  }

  /**
   * Recovers workflows that were marked as errored (e.g., auth failures)
   *
   * Called after preflight passes — if we can auth now, errored workflows
   * should be retried automatically.
   */
  private recoverErroredWorkflows(): void {
    const errored = getErroredWorkflows();
    if (errored.length === 0) return;

    this.logger.log(`🔄 Recovering ${errored.length} errored workflow(s)...`);
    for (const workflow of errored) {
      try {
        retryWorkflow(workflow.epicId);
        this.logger.log(`   ✓ ${workflow.epicId} (${workflow.sourceProject}/${workflow.sourceBeadId}) — ${workflow.errorType}`);
      } catch (err) {
        this.logger.error(`   ✗ Failed to recover ${workflow.epicId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Checks beads daemon health for all projects and restarts if needed
   */
  private async checkDaemonHealth(): Promise<void> {
    this.lastOperation = "checkDaemonHealth";
    let restartedCount = 0;

    for (const project of this.projects.values()) {
      const projectPath = expandPath(project.repoPath);
      if (!beads.isDaemonRunning(projectPath)) {
        this.logger.log(`🔄 Restarting beads daemon for ${project.name}...`);
        try {
          beads.ensureDaemonWithSyncBranch(projectPath, "beads-sync");
          restartedCount++;
        } catch (err) {
          this.logger.error(`   Failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Also check orchestrator
    const orchestratorPath = expandPath(this.config.orchestratorPath);
    if (!beads.isDaemonRunning(orchestratorPath)) {
      this.logger.log("🔄 Restarting beads daemon for orchestrator...");
      try {
        beads.ensureDaemonWithSyncBranch(orchestratorPath, "beads-sync");
        restartedCount++;
      } catch (err) {
        this.logger.error(`   Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (restartedCount > 0) {
      this.logger.log(`   Restarted ${restartedCount} daemon(s)`);
    }
  }

  /**
   * Clean up worktrees whose branches have been merged into main.
   * Runs periodically alongside daemon health checks.
   *
   * Uses `git merge-base --is-ancestor` against `origin/main` to detect
   * merged branches. This is more reliable than worktrunk's `mainState`
   * which compares against the local main ref — `git fetch origin` only
   * updates `origin/main`, not the local `main` branch, so worktrunk
   * still sees merged branches as "ahead".
   */
  private cleanupMergedWorktrees(): void {
    for (const project of this.projects.values()) {
      try {
        const projectPath = expandPath(project.repoPath);
        execSync("git fetch origin", {
          cwd: projectPath,
          encoding: "utf-8",
          timeout: 15000,
          stdio: "pipe",
        });

        const worktrees = listWorktrees(project.name);
        for (const wt of worktrees) {
          if (wt.isMain) continue;

          // Skip worktrees with uncommitted changes
          if (wt.workingTree?.modified || wt.workingTree?.staged || wt.workingTree?.untracked) {
            continue;
          }

          // Check if branch is merged into origin/main
          try {
            execSync(`git merge-base --is-ancestor ${wt.branch} origin/main`, {
              cwd: projectPath,
              encoding: "utf-8",
              timeout: 5000,
              stdio: "pipe",
            });
            // Exit code 0 = branch is ancestor of origin/main (merged)
            removeWorktree(project.name, wt.branch);
            this.logger.log(`🧹 Cleaned up merged worktree: ${project.name}/${wt.branch}`);
          } catch {
            // Exit code 1 = not merged, or branch ref invalid — skip
          }
        }
      } catch {
        // Non-critical — don't log noise if fetch/wt fails
      }
    }
  }

  private async tick(): Promise<void> {
    // Don't start new work if shutting down
    if (!this.isAcceptingWork()) {
      return;
    }

    // 0. Reconcile activeWork with actually running agents (zombie detection)
    this.lastOperation = "reconcileActiveWork";
    this.reconcileActiveWork();

    // 1. Check CI status for any pending steps
    this.lastOperation = "checkPendingCI";
    await this.checkPendingCI();

    // 2. Poll orchestrator beads for ready workflow steps
    // Note: Steps blocked by question beads or ci:pending won't appear in ready list
    this.lastOperation = "getReadyWorkflowSteps";
    const workflowSteps = this.getReadyWorkflowSteps();
    // Track per-project dispatch counts within this loop
    // (activeWork isn't updated until async dispatch runs)
    const stepDispatchedPerProject = new Map<string, number>();
    for (const step of workflowSteps) {
      if (this.isAtCapacity()) break;
      if (this.state.activeWork.has(step.id)) continue;
      if (this.runningAgents.has(step.id)) continue;

      // Check per-project capacity (active + dispatched this tick)
      const activeForProject = [...this.state.activeWork.values()].filter(
        (w) => w.workItem.project === step.project
      ).length + (stepDispatchedPerProject.get(step.project) || 0);
      if (activeForProject >= this.config.concurrency.maxPerProject) continue;

      // Mark step in_progress synchronously BEFORE async dispatch
      // This prevents the next tick from picking it up again
      try {
        markStepInProgress(step.id);
      } catch (err) {
        this.logger.error(`Failed to mark step ${step.id} in progress: ${err}`);
        continue;
      }

      // Dispatch asynchronously and track the promise
      const agentPromise = this.dispatchWorkflowStep(step)
        .catch((err) => {
          // Dispatch failed — use circuit breaker to reset or block
          const wasReset = resetStepForRetry(step.id, this.MAX_DISPATCH_ATTEMPTS);
          if (wasReset) {
            this.logger.warn(`⚠️  Dispatch failed for ${step.id}, will retry (${err instanceof Error ? err.message : String(err)})`);
          } else {
            this.logger.error(`🚫 Dispatch failed for ${step.id} after max attempts, marking blocked`);
          }
          // Clean up activeWork if it was added
          if (this.state.activeWork.has(step.id)) {
            this.state = removeActiveWork(this.state, step.id);
          }
          this.handleDispatchError(step, err);
        })
        .finally(() => {
          this.runningAgents.delete(step.id);
        });
      this.runningAgents.set(step.id, agentPromise);
      stepDispatchedPerProject.set(step.project, (stepDispatchedPerProject.get(step.project) || 0) + 1);
    }

    // 4. If under capacity, poll project beads for new work
    this.lastOperation = "pollProjectBacklogs";
    if (this.state.activeWork.size < this.config.concurrency.maxTotal) {
      const newWork = await this.pollProjectBacklogs();
      // Track per-project dispatch counts within this tick
      // (activeWork isn't updated until async startNewWorkflow runs)
      // Seed with workflow steps dispatched in section 2 above
      const dispatchedPerProject = new Map(stepDispatchedPerProject);
      let dispatchedTotal = dispatchedPerProject.size > 0
        ? [...dispatchedPerProject.values()].reduce((a, b) => a + b, 0)
        : 0;

      for (const next of newWork) {
        // Check total capacity (activeWork + dispatched this tick)
        if (this.state.activeWork.size + dispatchedTotal >= this.config.concurrency.maxTotal) break;

        // Check per-project capacity (active + dispatched this tick)
        const activeForProject = [...this.state.activeWork.values()].filter(
          (w) => w.workItem.project === next.project
        ).length + (dispatchedPerProject.get(next.project) || 0);
        if (activeForProject >= this.config.concurrency.maxPerProject) continue;

        const workflowPromise = this.startNewWorkflow(next)
          .catch((err) => {
            this.logger.error(`Failed to start workflow for ${next.id}: ${err}`);
          })
          .finally(() => {
            this.runningAgents.delete(next.id);
          });
        this.runningAgents.set(next.id, workflowPromise);

        dispatchedTotal++;
        dispatchedPerProject.set(next.project, (dispatchedPerProject.get(next.project) || 0) + 1);
      }
    }
  }

  /**
   * Reconciles activeWork with actually running agents.
   *
   * Detects zombies: entries in activeWork that have no corresponding
   * running agent promise. This catches:
   * - Agent process died without cleanup (kill -9, OOM)
   * - State loaded from disk after a crash (startup recovery)
   * - Promise rejection that wasn't caught
   */
  private reconcileActiveWork(): void {
    for (const [id, work] of this.state.activeWork) {
      if (!this.runningAgents.has(id)) {
        this.logger.warn(`🧟 Zombie detected: ${work.workItem.project}/${id} (in activeWork but no running agent)`);
        this.state = removeActiveWork(this.state, id);

        // Try to reset the step for retry (with circuit breaker)
        if (work.workflowStepId) {
          const wasReset = resetStepForRetry(work.workflowStepId, this.MAX_DISPATCH_ATTEMPTS);
          if (wasReset) {
            this.logger.log(`   Reset step ${work.workflowStepId} to open for retry`);
          } else {
            this.logger.log(`   Step ${work.workflowStepId} hit max dispatch attempts, marked blocked`);
          }
        }
      }
    }
  }

  private isAtCapacity(): boolean {
    return this.state.activeWork.size >= this.config.concurrency.maxTotal;
  }

  /**
   * Maximum CI retry attempts before marking as blocked
   */
  private readonly MAX_CI_RETRIES = 5;

  /**
   * Checks CI status for steps waiting on CI
   *
   * For each step with ci:pending, checks GitHub PR status:
   * - If passed: updates to ci:passed, step becomes ready for quality_review
   * - If failed: creates implementation step for fixes, tracks retry count
   * - After MAX_CI_RETRIES failures: marks workflow as BLOCKED
   */
  private async checkPendingCI(): Promise<void> {
    const pendingSteps = getStepsPendingCI();

    for (const step of pendingSteps) {
      try {
        // Resolve the project's repo path so gh commands run in the right repo
        const projectConfig = this.projects.get(step.project);
        if (!projectConfig) {
          this.logger.warn(`Cannot resolve project "${step.project}" for CI check on PR #${step.prNumber}`);
          continue;
        }
        const repoPath = expandPath(projectConfig.repoPath);

        // Check for merge conflicts before CI status — no point waiting for
        // CI if the PR can't merge
        const mergeability = this.getPRMergeability(step.prNumber, repoPath);
        if (mergeability === "CONFLICTING") {
          this.logger.log(`⚠️  PR #${step.prNumber} has merge conflicts`);
          updateStepCIStatus(step.id, "failed", step.retryCount);
          completeStep(step.id, "merge_conflicts");
          createNextStep(
            step.epicId,
            "implementation",
            `PR #${step.prNumber} has merge conflicts with the base branch. Resolve the conflicts and push updates.`,
            { pr_number: step.prNumber, ci_status: "failed" }
          );
          this.logger.log(`   Created implementation step to resolve merge conflicts`);
          continue;
        }

        const ciStatus = this.getGitHubCIStatus(step.prNumber, repoPath);

        if (ciStatus === "pending") {
          // Still running, skip
          continue;
        }

        if (ciStatus === "passed") {
          this.logger.log(`✅ CI passed for PR #${step.prNumber}`);

          // First CI pass for a quality_review step → redirect to implementation for PR feedback
          if (
            step.agent === "quality_review" &&
            !epicHasLabel(step.epicId, "pr-feedback:addressed")
          ) {
            this.logger.log(`   📝 Redirecting to implementation to address PR feedback`);
            updateStepCIStatus(step.id, "passed", step.retryCount);
            completeStep(step.id, "Redirected to implementation for PR feedback review");
            createNextStep(
              step.epicId,
              "implementation",
              `CI passed for PR #${step.prNumber}. Review and address any PR comments/feedback, then hand off to quality_review.\nCheck: gh pr view ${step.prNumber} --json comments,reviews`,
              { pr_number: step.prNumber, ci_status: "passed" }
            );
            addEpicLabel(step.epicId, "pr-feedback:addressed");
            continue;
          }

          // Normal path: unblock the step
          updateStepCIStatus(step.id, "passed", step.retryCount);
          continue;
        }

        if (ciStatus === "failed") {
          this.logger.log(`❌ CI failed for PR #${step.prNumber} (attempt ${step.retryCount + 1}/${this.MAX_CI_RETRIES})`);

          // Check retry limit
          if (step.retryCount + 1 >= this.MAX_CI_RETRIES) {
            this.logger.log(`🚫 Max CI retries reached for PR #${step.prNumber}, marking as BLOCKED`);
            updateStepCIStatus(step.id, "failed", step.retryCount);

            // Mark the workflow as blocked
            const sourceInfo = getSourceBeadInfo(step.epicId);
            if (sourceInfo) {
              await this.markWorkflowBlocked(
                {
                  workItem: {
                    id: step.id,
                    project: sourceInfo.project,
                    title: `PR #${step.prNumber}`,
                    description: "",
                    priority: 2,
                    type: "task",
                    status: "open",
                    labels: [],
                    dependencies: [],
                  },
                  workflowEpicId: step.epicId,
                  workflowStepId: step.id,
                  sessionId: "",
                  worktreePath: "",
                  startedAt: new Date(),
                  agent: "implementation",
                  costSoFar: 0,
                },
                `CI failed ${this.MAX_CI_RETRIES} times for PR #${step.prNumber}. Human intervention required.`
              );
            }
            continue;
          }

          // Update status and create new implementation step
          updateStepCIStatus(step.id, "failed", step.retryCount);

          // Close the current step
          completeStep(step.id, "ci_failed");

          // Create new implementation step for fixes
          createNextStep(
            step.epicId,
            "implementation",
            `CI failed for PR #${step.prNumber}. Please fix the failing checks and push updates.`,
            { pr_number: step.prNumber, ci_status: "failed" }
          );

          this.logger.log(`   Created implementation step to fix CI failures`);
        }
      } catch (err) {
        this.logger.error(`Failed to check CI for PR #${step.prNumber}: ${err}`);
      }
    }
  }

  /**
   * Gets CI status from GitHub for a PR
   *
   * Returns: "pending" | "passed" | "failed"
   */
  private getGitHubCIStatus(prNumber: number, cwd: string): "pending" | "passed" | "failed" {
    try {
      // Use gh pr checks to get CI status
      const result = execSync(
        `gh pr checks ${prNumber} --json state,bucket --jq '[.[] | .state] | unique'`,
        { encoding: "utf-8", timeout: 30000, cwd }
      ).trim();

      // Result is a JSON array like ["SUCCESS"] or ["PENDING"] or ["FAILURE", "SUCCESS"]
      const states: string[] = JSON.parse(result || "[]");

      // If any check is pending/in_progress, overall is pending
      if (states.some((s) => s === "PENDING" || s === "IN_PROGRESS" || s === "QUEUED")) {
        return "pending";
      }

      // If any check failed, overall is failed
      if (states.some((s) => s === "FAILURE" || s === "ERROR" || s === "CANCELLED")) {
        return "failed";
      }

      // All checks passed (or no checks)
      if (states.length === 0 || states.every((s) => s === "SUCCESS" || s === "SKIPPED")) {
        return "passed";
      }

      // Unknown state, treat as pending
      return "pending";
    } catch {
      // If gh command fails, treat as pending (will retry next tick)
      return "pending";
    }
  }

  /**
   * Checks if a PR has merge conflicts
   *
   * Returns: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
   */
  private getPRMergeability(prNumber: number, cwd: string): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
    try {
      const result = execSync(
        `gh pr view ${prNumber} --json mergeable --jq '.mergeable'`,
        { encoding: "utf-8", timeout: 30000, cwd }
      ).trim();

      if (result === "CONFLICTING") return "CONFLICTING";
      if (result === "MERGEABLE") return "MERGEABLE";
      return "UNKNOWN";
    } catch {
      return "UNKNOWN";
    }
  }

  /**
   * Gets ready workflow steps from the orchestrator beads
   */
  private getReadyWorkflowSteps(): WorkItem[] {
    try {
      const steps = getReadySteps();
      return steps.flatMap((step) => {
        // Resolve project name from the epic's source labels
        const epicId = step.epicId;
        const sourceInfo = epicId ? getSourceBeadInfo(epicId) : null;
        if (!sourceInfo) {
          this.logger.warn(`Cannot resolve project for step ${step.id} (epic: ${epicId})`);
          return [];
        }
        return [{
          id: step.id,
          project: sourceInfo.project,
          title: step.agent,
          description: step.context,
          priority: 2,
          type: "task" as const,
          status: step.status,
          labels: [],
          dependencies: [],
        }];
      });
    } catch (err) {
      // Orchestrator may not exist yet
      return [];
    }
  }

  /**
   * Polls all project beads for ready work items
   */
  private async pollProjectBacklogs(): Promise<WorkItem[]> {
    const items: WorkItem[] = [];

    for (const [name, project] of this.projects) {
      // Check per-project concurrency limit
      const activeForProject = [...this.state.activeWork.values()].filter(
        (w) => w.workItem.project === name
      ).length;

      if (activeForProject >= this.config.concurrency.maxPerProject) {
        continue;
      }

      // Check if there's already a workflow for any ready beads
      try {
        const projectPath = expandPath(project.repoPath);
        const readyBeads = beads.ready(projectPath);

        for (const bead of readyBeads) {
          // Skip if workflow already exists for this bead
          const existing = getWorkflowForSource(name, bead.id);
          if (existing) continue;

          items.push(this.beadToWorkItem(bead, name));
        }
      } catch (err) {
        // Project beads may not be initialized
        this.logger.warn(`Failed to poll ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Sort by priority (lower number = higher priority)
    items.sort((a, b) => a.priority - b.priority);
    return items;
  }

  /**
   * Converts a Bead to a WorkItem
   */
  private beadToWorkItem(bead: Bead, project: string): WorkItem {
    return {
      id: bead.id,
      project,
      title: bead.title,
      description: bead.description || "",
      priority: bead.priority ?? 2,
      type: (bead.type as WorkItem["type"]) || "task",
      status: bead.status as WorkItem["status"],
      labels: bead.labels || [],
      dependencies: bead.dependencies || [],
    };
  }

  /**
   * Starts a new workflow for a source bead
   */
  private async startNewWorkflow(item: WorkItem): Promise<void> {
    this.lastOperation = `startNewWorkflow:${item.project}/${item.id}`;
    this.logger.log(`📋 Starting workflow: ${item.project}/${item.id} - ${item.title}`);

    const project = this.projects.get(item.project);
    if (!project) {
      throw new Error(`Project not found: ${item.project}`);
    }

    // 1. Determine first agent based on work type
    const firstAgent = getFirstAgent(item);

    // 2. Create workflow epic and first step
    const { epicId, stepId } = await startWorkflow(item.project, item, firstAgent);
    this.logger.log(`   Created workflow ${epicId}, step ${stepId}`);

    // Record metrics
    recordWorkflowStart(epicId, item.project, item.id);
    recordStepStart(stepId, epicId, firstAgent);

    // 3. Create worktree for this work item
    const worktreePath = ensureWorktree(item.project, item.id, {
      baseBranch: project.baseBranch,
    });
    this.logger.log(`   Worktree: ${worktreePath}`);

    // 4. Track as active work
    const activeWork: ActiveWork = {
      workItem: item,
      workflowEpicId: epicId,
      workflowStepId: stepId,
      sessionId: "",
      worktreePath,
      startedAt: new Date(),
      agent: firstAgent,
      costSoFar: 0,
    };
    this.state = addActiveWork(this.state, activeWork);

    // 5. Dispatch the first agent
    await this.runAgentStep(activeWork);
  }

  /**
   * Dispatches a workflow step (continuing an existing workflow)
   */
  private async dispatchWorkflowStep(step: WorkItem): Promise<void> {
    this.lastOperation = `dispatchWorkflowStep:${step.id}`;
    // Get the parent epic first, then extract source info from it
    const epic = getWorkflowEpic(step.id);
    if (!epic) {
      this.logger.error(`Cannot find workflow epic for step ${step.id}`);
      return;
    }

    // Get source bead info from the workflow epic (not the step)
    const sourceInfo = getSourceBeadInfo(epic.id);
    if (!sourceInfo) {
      this.logger.error(`Cannot find source labels on epic ${epic.id}`);
      return;
    }

    const project = this.projects.get(sourceInfo.project);
    if (!project) {
      this.logger.error(`Project not found: ${sourceInfo.project}`);
      return;
    }

    const agent = step.title; // Step title is the agent name
    // Extract human-readable title from epic (format: "project:beadId - Title")
    const epicTitle = epic.title.includes(" - ") ? epic.title.split(" - ").slice(1).join(" - ") : epic.title;

    // Check if this step has resume info (was blocked by a question that's now answered)
    const resumeInfo = getStepResumeInfo(step.id);
    if (resumeInfo) {
      this.logger.log(`🔄 Resuming ${agent} for ${sourceInfo.project}/${sourceInfo.beadId} — ${epicTitle} (answer provided)`);
    } else {
      this.logger.log(`🔄 Dispatching ${agent} for ${sourceInfo.project}/${sourceInfo.beadId} — ${epicTitle}`);
    }

    // Use worktree from resume info if available, otherwise ensure it exists
    const worktreePath = resumeInfo?.worktree || ensureWorktree(sourceInfo.project, sourceInfo.beadId, {
      baseBranch: project.baseBranch,
    });

    // Use the epic ID we already fetched
    const epicId = epic.id;

    // Note: markStepInProgress is called synchronously in tick() before
    // this async dispatch, to prevent race conditions with the next tick.

    // Create active work entry
    const activeWork: ActiveWork = {
      workItem: {
        ...step,
        title: epicTitle,
        project: sourceInfo.project,
      },
      workflowEpicId: epicId,
      workflowStepId: step.id,
      sessionId: resumeInfo?.sessionId || "",
      worktreePath,
      startedAt: new Date(),
      agent,
      costSoFar: 0,
    };
    this.state = addActiveWork(this.state, activeWork);

    // Record step start in metrics (only for new dispatches, not resumes)
    if (!resumeInfo) {
      recordStepStart(step.id, epicId, agent);
    }

    // Run or resume the agent
    if (resumeInfo) {
      // Clear the resume info now that we're using it
      clearStepResumeInfo(step.id);
      await this.resumeAgentStep(activeWork, resumeInfo.sessionId, resumeInfo.answer);
    } else {
      await this.runAgentStep(activeWork);
    }
  }

  /**
   * Runs an agent for a workflow step
   */
  private async runAgentStep(work: ActiveWork): Promise<void> {
    this.lastOperation = `runAgentStep:${work.agent}:${work.workItem.project}/${work.workItem.id}`;
    const project = this.projects.get(work.workItem.project);
    if (!project) {
      throw new Error(`Project not found: ${work.workItem.project}`);
    }

    // Build prompt for the agent
    const workflowContext = getWorkflowContext(work.workflowStepId);
    const sourceInfo = getSourceBeadInfo(work.workflowEpicId);
    const prompt = formatAgentPrompt({
      taskTitle: work.workItem.title,
      taskDescription: work.workItem.description,
      workflowContext,
      agentRole: this.getAgentRole(work.agent, work.workItem),
      branchName: sourceInfo?.beadId,
      agent: work.agent,
    });

    await this.notifier.notifyProgress(work, `Running ${work.agent} agent`);

    // Log step start
    logAgentEvent(work.workflowStepId, { type: "start", agent: work.agent, step: work.workflowStepId });

    try {
      // Run the agent
      const result = await this.agentRunner.run({
        prompt,
        cwd: work.worktreePath,
        maxTurns: this.MAX_AGENT_TURNS,
        onOutput: (text) => {
          logAgentEvent(work.workflowStepId, { type: "text", text });
        },
        onToolUse: (tool, input) => {
          const inputStr = typeof input === "string" ? input : JSON.stringify(input);
          logAgentEvent(work.workflowStepId, { type: "tool", name: tool, input: inputStr });
        },
      });

      // Update session ID and cost
      this.state = updateActiveWork(this.state, work.workItem.id, {
        sessionId: result.sessionId,
        costSoFar: work.costSoFar + result.costUsd,
      });

      // Check for authentication errors - these require human intervention
      if (result.isAuthError) {
        await this.handleAuthError(work, result.error || "Authentication failed");
        return;
      }

      // Check for pending question
      if (result.pendingQuestion) {
        await this.handlePendingQuestion(work, result);
        return;
      }

      // Get handoff (trust but verify)
      const handoff = await getHandoff(
        result.output,
        result.sessionId,
        work.worktreePath,
        this.agentRunner
      );

      // Detect turn limit hit — but honor valid handoffs even at the limit
      if (result.turns >= this.MAX_AGENT_TURNS && handoff.next_agent === "BLOCKED") {
        this.logger.warn(
          `⚠️ Agent ${work.agent} hit turn limit (${result.turns}/${this.MAX_AGENT_TURNS}) with no valid handoff — marking BLOCKED`
        );
        await this.notifier.notifyProgress(
          work,
          `Agent hit turn limit (${result.turns} turns) — needs human intervention`
        );
      } else if (result.turns >= this.MAX_AGENT_TURNS) {
        this.logger.log(
          `ℹ️ Agent ${work.agent} hit turn limit (${result.turns}/${this.MAX_AGENT_TURNS}) but produced valid handoff → ${handoff.next_agent}`
        );
      }

      // Process handoff
      await this.processHandoff(work, handoff, result.costUsd);
    } catch (err) {
      await this.handleAgentError(work, err);
    }
  }

  /**
   * Resumes an agent after a question was answered
   *
   * Similar to runAgentStep but uses resumeWithAnswer to continue
   * an existing session with the provided answer.
   */
  private async resumeAgentStep(
    work: ActiveWork,
    sessionId: string,
    answer: string
  ): Promise<void> {
    this.lastOperation = `resumeAgentStep:${work.agent}:${work.workItem.project}/${work.workItem.id}`;
    await this.notifier.notifyProgress(work, `Resuming ${work.agent} agent with answer`);

    // Log resume
    logAgentEvent(work.workflowStepId, { type: "text", text: "Resuming with answer" });

    try {
      // Resume the agent session with the answer
      const result = await this.agentRunner.resumeWithAnswer(sessionId, answer, {
        cwd: work.worktreePath,
        maxTurns: this.MAX_AGENT_TURNS,
        onOutput: (text) => {
          logAgentEvent(work.workflowStepId, { type: "text", text });
        },
        onToolUse: (tool, input) => {
          const inputStr = typeof input === "string" ? input : JSON.stringify(input);
          logAgentEvent(work.workflowStepId, { type: "tool", name: tool, input: inputStr });
        },
      });

      // Update session ID and cost
      this.state = updateActiveWork(this.state, work.workItem.id, {
        sessionId: result.sessionId,
        costSoFar: work.costSoFar + result.costUsd,
      });

      // Check for authentication errors - these require human intervention
      if (result.isAuthError) {
        await this.handleAuthError(work, result.error || "Authentication failed");
        return;
      }

      // Check if resume produced no output — session may have expired.
      // Fall back to a fresh agent run with the Q&A context injected,
      // instead of going through the doomed handoff detection chain.
      if (!result.output.trim() && !result.pendingQuestion) {
        this.logger.warn(
          `⚠️ Session resume produced no output (session ${sessionId} may have expired)`
        );
        this.logger.log(`   Falling back to fresh agent run with answer context`);

        // Enrich the description with the Q&A so the fresh agent has context
        const enrichedWork: ActiveWork = {
          ...work,
          workItem: {
            ...work.workItem,
            description:
              work.workItem.description +
              `\n\n## Previously Asked Question & Answer\n` +
              `The previous agent session asked a question and received this answer:\n\n` +
              `**Answer:** ${answer}\n\n` +
              `Please incorporate this answer into your work.`,
          },
          sessionId: "", // Fresh session
        };

        await this.runAgentStep(enrichedWork);
        return;
      }

      // Check for another pending question
      if (result.pendingQuestion) {
        await this.handlePendingQuestion(work, result);
        return;
      }

      // Get handoff (trust but verify)
      const handoff = await getHandoff(
        result.output,
        result.sessionId,
        work.worktreePath,
        this.agentRunner
      );

      // Detect turn limit hit — but honor valid handoffs even at the limit
      if (result.turns >= this.MAX_AGENT_TURNS && handoff.next_agent === "BLOCKED") {
        this.logger.warn(
          `⚠️ Agent ${work.agent} hit turn limit (${result.turns}/${this.MAX_AGENT_TURNS}) with no valid handoff — marking BLOCKED`
        );
        await this.notifier.notifyProgress(
          work,
          `Agent hit turn limit (${result.turns} turns) — needs human intervention`
        );
      } else if (result.turns >= this.MAX_AGENT_TURNS) {
        this.logger.log(
          `ℹ️ Agent ${work.agent} hit turn limit (${result.turns}/${this.MAX_AGENT_TURNS}) but produced valid handoff → ${handoff.next_agent}`
        );
      }

      // Process handoff
      await this.processHandoff(work, handoff, result.costUsd);
    } catch (err) {
      await this.handleAgentError(work, err);
    }
  }

  /**
   * Handles a pending question from an agent
   *
   * Creates a question bead that blocks the workflow step.
   * When answered via CLI, the question bead is closed which unblocks the step.
   */
  private async handlePendingQuestion(
    work: ActiveWork,
    result: { sessionId: string; pendingQuestion?: { questions: any[]; context: string } }
  ): Promise<void> {
    if (!result.pendingQuestion) return;

    const orchestratorPath = expandPath(this.config.orchestratorPath);

    // Build question bead data (stored as JSON in description)
    const questionData: QuestionBeadData = {
      metadata: {
        session_id: result.sessionId,
        worktree: work.worktreePath,
        step_id: work.workflowStepId,
        epic_id: work.workflowEpicId,
        project: work.workItem.project,
        asked_at: new Date().toISOString(),
      },
      context: result.pendingQuestion.context,
      questions: result.pendingQuestion.questions,
    };

    // Create question bead that blocks the step
    const questionBead = beads.createQuestion(
      `Question: ${result.pendingQuestion.questions[0]?.question || "Agent needs input"}`,
      orchestratorPath,
      questionData,
      work.workflowEpicId,
      work.workflowStepId
    );

    // Reset step to open — the question bead blocks it via dependency,
    // so bd ready won't return it until the question is answered (bead closed).
    markStepOpen(work.workflowStepId);

    // Remove from active work (paused until answered)
    this.state = removeActiveWork(this.state, work.workItem.id);

    await this.notifier.notifyQuestion(questionBead.id, questionData);
    this.logger.log(`❓ Question pending: ${questionBead.id}`);
  }

  /**
   * Processes a handoff from an agent
   */
  private async processHandoff(
    work: ActiveWork,
    handoff: { next_agent: string; pr_number?: number; ci_status?: string; context: string },
    stepCost: number
  ): Promise<void> {
    this.lastOperation = `processHandoff:${work.agent}->${handoff.next_agent}:${work.workItem.project}/${work.workItem.id}`;
    this.logger.log(`🔀 Handoff: ${work.agent} → ${handoff.next_agent}`);

    // Log step end
    logAgentEvent(work.workflowStepId, { type: "end", agent: work.agent, outcome: handoff.next_agent, cost: stepCost });

    // Complete the current step
    completeStep(work.workflowStepId, handoff.context);

    // Record step completion in metrics
    recordStepComplete(work.workflowStepId, stepCost, handoff.next_agent);

    // Remove from active work
    this.state = removeActiveWork(this.state, work.workItem.id);

    // Handle terminal states
    if (handoff.next_agent === "DONE") {
      await this.completeWorkflowSuccess(work, handoff.context);
      return;
    }

    if (handoff.next_agent === "BLOCKED") {
      await this.markWorkflowBlocked(work, handoff.context);
      return;
    }

    // Create next step
    if (isValidAgent(handoff.next_agent)) {
      createNextStep(work.workflowEpicId, handoff.next_agent, handoff.context, {
        pr_number: handoff.pr_number,
        ci_status: handoff.ci_status as "pending" | "passed" | "failed" | undefined,
      });
      this.logger.log(`   Next step created for ${handoff.next_agent}`);
    } else {
      this.logger.error(`Invalid next agent: ${handoff.next_agent}, marking blocked`);
      await this.markWorkflowBlocked(work, `Invalid agent: ${handoff.next_agent}`);
    }
  }

  /**
   * Completes a workflow successfully
   */
  private async completeWorkflowSuccess(work: ActiveWork, reason: string): Promise<void> {
    completeWorkflow(work.workflowEpicId, "done", reason);
    recordWorkflowComplete(work.workflowEpicId, "done");

    // Get the source bead info from the workflow epic (not from workItem.id which may be a step ID)
    const sourceInfo = getSourceBeadInfo(work.workflowEpicId);
    if (!sourceInfo) {
      this.logger.warn(`Could not find source bead info for epic ${work.workflowEpicId}`);
      return;
    }

    // Close the source bead in the project
    const project = this.projects.get(sourceInfo.project);
    if (project) {
      try {
        beads.close(
          sourceInfo.beadId,
          `Completed by WHS workflow`,
          expandPath(project.repoPath)
        );
        this.logger.log(`   Closed source bead: ${sourceInfo.project}/${sourceInfo.beadId}`);
      } catch (err) {
        this.logger.warn(`Failed to close source bead ${sourceInfo.beadId}: ${err}`);
      }
    }

    // Clean up worktree (branch is named after the source bead ID, not the step ID)
    try {
      removeWorktree(sourceInfo.project, sourceInfo.beadId, { force: true });
    } catch (err) {
      this.logger.warn(`Failed to remove worktree ${sourceInfo.project}/${sourceInfo.beadId}: ${err}`);
    }

    await this.notifier.notifyComplete(work, "done");
    this.logger.log(`✅ Workflow complete: ${sourceInfo.project}/${sourceInfo.beadId}`);
  }

  /**
   * Marks a workflow as blocked
   */
  private async markWorkflowBlocked(work: ActiveWork, reason: string): Promise<void> {
    completeWorkflow(work.workflowEpicId, "blocked", reason);
    recordWorkflowComplete(work.workflowEpicId, "blocked");
    await this.notifier.notifyComplete(work, "blocked");
    this.logger.log(`🚫 Workflow blocked: ${work.workItem.project}/${work.workItem.id} - ${reason}`);
  }

  /**
   * Handles an authentication error - stops the dispatcher entirely
   *
   * Auth errors require human intervention (re-login, API key refresh)
   * so we stop all work and notify loudly. Uses errored:auth label
   * (not blocked:human) so the workflow auto-recovers on restart.
   */
  private async handleAuthError(work: ActiveWork, message: string): Promise<void> {
    this.logger.error("\n" + "=".repeat(60));
    this.logger.error("🔐 AUTHENTICATION ERROR - STOPPING DISPATCHER");
    this.logger.error("=".repeat(60));
    this.logger.error(`\nError: ${message}`);
    this.logger.error("\nAll agents have been stopped. Please fix authentication:");
    this.logger.error("  1. Run 'whs claude-login' to refresh OAuth token, or");
    this.logger.error("  2. Set ANTHROPIC_API_KEY in ~/work/whs-orchestrator/.whs/.env");
    this.logger.error("\nThen restart the dispatcher with 'whs start'");
    this.logger.error("=".repeat(60) + "\n");

    // Notify about the auth error
    await this.notifier.notifyError(work, new Error(`Authentication failed: ${message}`));

    // Mark workflow as errored (not blocked) — will auto-recover on restart
    errorWorkflow(work.workflowEpicId, `Authentication error: ${message}`, "auth");
    recordWorkflowComplete(work.workflowEpicId, "error");
    this.state = removeActiveWork(this.state, work.workItem.id);

    // Stop the dispatcher entirely - auth errors affect all agents
    await this.stop();
  }

  /**
   * Handles an error during agent execution
   */
  private async handleAgentError(work: ActiveWork, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);

    if (this.isRateLimitError(err)) {
      this.logger.log("⚠️  Rate limit hit, pausing dispatcher");
      await this.notifier.notifyRateLimit(err as Error);
      this.pause();
      // Keep work item active for retry
      return;
    }

    this.logger.error(`❌ Agent error for ${work.workItem.id}: ${message}`);
    await this.notifier.notifyError(work, err as Error);

    // Mark workflow as blocked
    await this.markWorkflowBlocked(work, `Agent error: ${message}`);
    this.state = removeActiveWork(this.state, work.workItem.id);
  }

  /**
   * Handles errors during dispatch
   */
  private async handleDispatchError(work: WorkItem, err: unknown): Promise<void> {
    if (this.isRateLimitError(err)) {
      this.logger.log("⚠️  Rate limit detected, pausing");
      await this.notifier.notifyRateLimit(err as Error);
      this.pause();
      return;
    }

    this.logger.error(`Error dispatching ${work.id}: ${err}`);
  }

  private isRateLimitError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
      message.toLowerCase().includes("rate limit") ||
      message.includes("429") ||
      message.toLowerCase().includes("too many requests")
    );
  }

  /**
   * Gets the role description for an agent
   */
  private getAgentRole(agent: string, workItem?: WorkItem): string {
    if (agent === "planner") {
      return this.getPlannerRole(workItem);
    }

    const roles: Record<string, string> = {
      implementation: "You are a senior software engineer. Implement the requested changes, create a PR when ready.",
      quality_review: "You are a code reviewer. Review the PR, check CI status, and decide if it's ready to merge.",
      release_manager: "You are a release manager. Merge approved PRs and handle any merge conflicts.",
      ux_specialist: "You are a UX specialist. Implement UI/UX changes following design best practices.",
      architect: "You are a software architect. Make technical decisions and unblock complex issues.",
    };
    return roles[agent] || `You are the ${agent} agent.`;
  }

  /**
   * Builds the planner role with the project epic ID injected
   */
  private getPlannerRole(workItem?: WorkItem): string {
    // Extract epic ID from the planning task's labels (epic:<id>)
    const epicLabel = workItem?.labels?.find((l) => l.startsWith("epic:"));
    const epicId = epicLabel?.replace("epic:", "") || "<EPIC_ID>";

    return [
      "You are a technical planner. Your ONLY job is to analyze the codebase, ask clarifying questions, and create implementation tasks in beads.",
      "",
      "Do NOT write code, create PRs, or make commits. Do NOT implement anything.",
      "",
      "Your workflow:",
      "1. Read CLAUDE.md and explore the codebase to understand the project",
      "2. Ask clarifying questions using AskUserQuestion if anything is unclear",
      "3. Present your implementation plan and ask for approval",
      `4. After approval, create tasks under epic ${epicId}:`,
      `   bd create "Task title" -t task --parent ${epicId} --description "Description with acceptance criteria"`,
      "5. Set up dependencies between tasks:",
      "   bd dep add <TASK_B_ID> <TASK_A_ID>",
      "6. Hand off with next_agent: DONE",
    ].join("\n");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // === Public API for CLI ===

  /**
   * Gets pending questions from orchestrator beads
   */
  getPendingQuestions(): Array<{ id: string; data: QuestionBeadData }> {
    const orchestratorPath = expandPath(this.config.orchestratorPath);
    const questionBeads = beads.listPendingQuestions(orchestratorPath);
    return questionBeads.map((bead) => ({
      id: bead.id,
      data: beads.parseQuestionData(bead),
    }));
  }

  /**
   * Gets the current dispatcher status
   */
  getStatus(): {
    active: ActiveWork[];
    pendingQuestionCount: number;
    paused: boolean;
    startedAt: Date;
    todayCost: number;
  } {
    const orchestratorPath = expandPath(this.config.orchestratorPath);
    const pendingQuestions = beads.listPendingQuestions(orchestratorPath);

    let todayCost = 0;
    try {
      todayCost = getTodayCost();
    } catch {
      // metrics DB may not be initialized
    }

    return {
      active: [...this.state.activeWork.values()],
      pendingQuestionCount: pendingQuestions.length,
      paused: this.state.paused,
      startedAt: this.startedAt,
      todayCost,
    };
  }
}
