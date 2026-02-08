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
  resetStepForRetry,
  getWorkflowForSource,
  getStepResumeInfo,
  clearStepResumeInfo,
  getStepsPendingCI,
  updateStepCIStatus,
} from "./workflow.js";
import { execSync } from "child_process";
import { ensureWorktree, removeWorktree } from "./worktree.js";
import { formatAgentPrompt, type AgentRunner } from "./agent-runner.js";
import { createAgentRunner } from "./agent-runner-factory.js";
import { getHandoff, isValidAgent } from "./handoff.js";
import type { Bead } from "./beads/types.js";

export class Dispatcher {
  private projects: Map<string, Project>;
  private state: DispatcherState;
  private notifier: Notifier;
  private agentRunner: AgentRunner;
  private running: boolean = false;
  private shuttingDown: boolean = false;
  private tickCount: number = 0;
  private runningAgents: Map<string, Promise<void>> = new Map();
  private shutdownResolve: (() => void) | null = null;

  private readonly config: Config;

  // Check daemon health every 60 ticks (5 min at 5s intervals)
  private readonly DAEMON_HEALTH_CHECK_INTERVAL = 60;
  // Graceful shutdown timeout (wait for agents)
  private readonly GRACEFUL_SHUTDOWN_TIMEOUT_MS = 300000; // 5 minutes
  // Max dispatch attempts before circuit breaker trips
  private readonly MAX_DISPATCH_ATTEMPTS = 3;
  // Max agent turns — if agent uses this many, it likely hit the limit
  private readonly MAX_AGENT_TURNS = 50;

  constructor(config: Config, notifier: Notifier, agentRunner?: AgentRunner) {
    this.config = config;
    this.projects = new Map(config.projects.map((p) => [p.name, p]));
    this.notifier = notifier;
    this.agentRunner = agentRunner ?? createAgentRunner(config.runnerType);

    // Load persisted state for crash recovery
    this.state = loadState();
  }

  async start(): Promise<void> {
    // Check if another dispatcher is already running
    const existingLock = getLockInfo();
    if (existingLock) {
      console.error("❌ Another dispatcher is already running!");
      console.error(`   PID: ${existingLock.pid}`);
      console.error(`   Started: ${existingLock.startedAt}`);
      console.error("");
      console.error("Use `whs status` to check its status, or kill the process manually.");
      throw new Error("Dispatcher already running");
    }

    // Acquire lock
    if (!acquireLock()) {
      console.error("❌ Failed to acquire dispatcher lock");
      throw new Error("Failed to acquire lock");
    }

    console.log("🌙 While Humans Sleep - Starting dispatcher");
    console.log(`   PID: ${process.pid}`);
    console.log(`   Projects: ${[...this.projects.keys()].join(", ") || "(none)"}`);
    console.log(`   Max concurrent: ${this.config.concurrency.maxTotal}`);
    console.log(`   Orchestrator: ${this.config.orchestratorPath}`);

    if (this.state.activeWork.size > 0) {
      console.log(`   Recovering: ${this.state.activeWork.size} active work items`);
    }
    // Check for pending questions in orchestrator beads
    const orchestratorPath = expandPath(this.config.orchestratorPath);
    const pendingQuestions = beads.listPendingQuestions(orchestratorPath);
    if (pendingQuestions.length > 0) {
      console.log(`   Pending questions: ${pendingQuestions.length}`);
    }
    console.log("");

    this.running = true;

    // Pause/resume signal handlers (used by `whs pause` and `whs resume`)
    const onPause = (): void => { this.pause(); };
    const onResume = (): void => { this.resume(); };
    process.on("SIGUSR1", onPause);
    process.on("SIGUSR2", onResume);

    while (this.running) {
      if (!this.state.paused) {
        try {
          await this.tick();
          this.tickCount++;

          // Periodic daemon health check
          if (this.tickCount % this.DAEMON_HEALTH_CHECK_INTERVAL === 0) {
            await this.checkDaemonHealth();
          }
        } catch (err) {
          console.error("Error in dispatcher tick:", err);
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
      console.log("\n⚠️  Force stopping (agents may lose work)...");
      this.forceStop();
      return;
    }

    this.shuttingDown = true;
    const activeCount = this.runningAgents.size;

    if (activeCount === 0) {
      console.log("\n🛑 No active agents, stopping immediately...");
      this.forceStop();
      return;
    }

    console.log(`\n🛑 Graceful shutdown requested...`);
    console.log(`   Waiting for ${activeCount} active agent(s) to complete.`);
    console.log(`   Press Ctrl+C again to force stop.\n`);

    // Wait for all running agents with timeout
    const agentPromises = [...this.runningAgents.values()];
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        console.log("\n⏰ Graceful shutdown timeout reached.");
        resolve();
      }, this.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    });

    // Create a promise that resolves when shutdown is forced
    const forcePromise = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
    });

    await Promise.race([
      Promise.all(agentPromises),
      timeoutPromise,
      forcePromise,
    ]);

    this.forceStop();
  }

  /**
   * Force stop - immediate shutdown without waiting
   */
  private forceStop(): void {
    console.log("🛑 Stopping dispatcher...");
    this.running = false;

    // Remove signal handlers
    process.removeAllListeners("SIGUSR1");
    process.removeAllListeners("SIGUSR2");

    // Abort any running agents
    if (this.runningAgents.size > 0) {
      console.log(`   Aborting ${this.runningAgents.size} running agent(s)...`);
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
    console.log("⏸️  Dispatcher paused");
  }

  resume(): void {
    this.state = setPaused(this.state, false);
    console.log("▶️  Dispatcher resumed");
  }

  /**
   * Checks beads daemon health for all projects and restarts if needed
   */
  private async checkDaemonHealth(): Promise<void> {
    let restartedCount = 0;

    for (const project of this.projects.values()) {
      const projectPath = expandPath(project.repoPath);
      if (!beads.isDaemonRunning(projectPath)) {
        console.log(`🔄 Restarting beads daemon for ${project.name}...`);
        try {
          beads.ensureDaemonWithSyncBranch(projectPath, "beads-sync");
          restartedCount++;
        } catch (err) {
          console.error(`   Failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Also check orchestrator
    const orchestratorPath = expandPath(this.config.orchestratorPath);
    if (!beads.isDaemonRunning(orchestratorPath)) {
      console.log("🔄 Restarting beads daemon for orchestrator...");
      try {
        beads.ensureDaemonWithSyncBranch(orchestratorPath, "beads-sync");
        restartedCount++;
      } catch (err) {
        console.error(`   Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (restartedCount > 0) {
      console.log(`   Restarted ${restartedCount} daemon(s)`);
    }
  }

  private async tick(): Promise<void> {
    // Don't start new work if shutting down
    if (!this.isAcceptingWork()) {
      return;
    }

    // 0. Reconcile activeWork with actually running agents (zombie detection)
    this.reconcileActiveWork();

    // 1. Check CI status for any pending steps
    await this.checkPendingCI();

    // 2. Poll orchestrator beads for ready workflow steps
    // Note: Steps blocked by question beads or ci:pending won't appear in ready list
    const workflowSteps = this.getReadyWorkflowSteps();
    for (const step of workflowSteps) {
      if (this.isAtCapacity()) break;
      if (this.state.activeWork.has(step.id)) continue;
      if (this.runningAgents.has(step.id)) continue;

      // Mark step in_progress synchronously BEFORE async dispatch
      // This prevents the next tick from picking it up again
      try {
        markStepInProgress(step.id);
      } catch (err) {
        console.error(`Failed to mark step ${step.id} in progress:`, err);
        continue;
      }

      // Dispatch asynchronously and track the promise
      const agentPromise = this.dispatchWorkflowStep(step)
        .catch((err) => {
          // Dispatch failed — use circuit breaker to reset or block
          const wasReset = resetStepForRetry(step.id, this.MAX_DISPATCH_ATTEMPTS);
          if (wasReset) {
            console.warn(`⚠️  Dispatch failed for ${step.id}, will retry (${err instanceof Error ? err.message : String(err)})`);
          } else {
            console.error(`🚫 Dispatch failed for ${step.id} after max attempts, marking blocked`);
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
    }

    // 4. If under capacity, poll project beads for new work
    if (this.state.activeWork.size < this.config.concurrency.maxTotal) {
      const newWork = await this.pollProjectBacklogs();
      // Track per-project dispatch counts within this tick
      // (activeWork isn't updated until async startNewWorkflow runs)
      const dispatchedPerProject = new Map<string, number>();
      let dispatchedTotal = 0;

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
            console.error(`Failed to start workflow for ${next.id}:`, err);
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
        console.warn(`🧟 Zombie detected: ${work.workItem.project}/${id} (in activeWork but no running agent)`);
        this.state = removeActiveWork(this.state, id);

        // Try to reset the step for retry (with circuit breaker)
        if (work.workflowStepId) {
          const wasReset = resetStepForRetry(work.workflowStepId, this.MAX_DISPATCH_ATTEMPTS);
          if (wasReset) {
            console.log(`   Reset step ${work.workflowStepId} to open for retry`);
          } else {
            console.log(`   Step ${work.workflowStepId} hit max dispatch attempts, marked blocked`);
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
        const ciStatus = this.getGitHubCIStatus(step.prNumber);

        if (ciStatus === "pending") {
          // Still running, skip
          continue;
        }

        if (ciStatus === "passed") {
          console.log(`✅ CI passed for PR #${step.prNumber}`);
          updateStepCIStatus(step.id, "passed", step.retryCount);
          // Step will now be picked up as ready (ci:passed, no ci:pending)
          continue;
        }

        if (ciStatus === "failed") {
          console.log(`❌ CI failed for PR #${step.prNumber} (attempt ${step.retryCount + 1}/${this.MAX_CI_RETRIES})`);

          // Check retry limit
          if (step.retryCount + 1 >= this.MAX_CI_RETRIES) {
            console.log(`🚫 Max CI retries reached for PR #${step.prNumber}, marking as BLOCKED`);
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

          console.log(`   Created implementation step to fix CI failures`);
        }
      } catch (err) {
        console.error(`Failed to check CI for PR #${step.prNumber}:`, err);
      }
    }
  }

  /**
   * Gets CI status from GitHub for a PR
   *
   * Returns: "pending" | "passed" | "failed"
   */
  private getGitHubCIStatus(prNumber: number): "pending" | "passed" | "failed" {
    try {
      // Use gh pr checks to get CI status
      const result = execSync(
        `gh pr checks ${prNumber} --json state,bucket --jq '[.[] | .state] | unique'`,
        { encoding: "utf-8", timeout: 30000 }
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
   * Gets ready workflow steps from the orchestrator beads
   */
  private getReadyWorkflowSteps(): WorkItem[] {
    try {
      const steps = getReadySteps();
      return steps.map((step) => ({
        id: step.id,
        project: "", // Will be filled from epic
        title: step.agent,
        description: step.context,
        priority: 2,
        type: "task" as const,
        status: step.status,
        labels: [],
        dependencies: [],
      }));
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
        console.warn(`Failed to poll ${name}: ${err instanceof Error ? err.message : String(err)}`);
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
    console.log(`📋 Starting workflow: ${item.project}/${item.id} - ${item.title}`);

    const project = this.projects.get(item.project);
    if (!project) {
      throw new Error(`Project not found: ${item.project}`);
    }

    // 1. Determine first agent based on work type
    const firstAgent = getFirstAgent(item);

    // 2. Create workflow epic and first step
    const { epicId, stepId } = await startWorkflow(item.project, item, firstAgent);
    console.log(`   Created workflow ${epicId}, step ${stepId}`);

    // 3. Create worktree for this work item
    const worktreePath = ensureWorktree(item.project, item.id, {
      baseBranch: project.baseBranch,
    });
    console.log(`   Worktree: ${worktreePath}`);

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
    // Get the parent epic first, then extract source info from it
    const epic = getWorkflowEpic(step.id);
    if (!epic) {
      console.error(`Cannot find workflow epic for step ${step.id}`);
      return;
    }

    // Get source bead info from the workflow epic (not the step)
    const sourceInfo = getSourceBeadInfo(epic.id);
    if (!sourceInfo) {
      console.error(`Cannot find source labels on epic ${epic.id}`);
      return;
    }

    const project = this.projects.get(sourceInfo.project);
    if (!project) {
      console.error(`Project not found: ${sourceInfo.project}`);
      return;
    }

    const agent = step.title; // Step title is the agent name

    // Check if this step has resume info (was blocked by a question that's now answered)
    const resumeInfo = getStepResumeInfo(step.id);
    if (resumeInfo) {
      console.log(`🔄 Resuming ${agent} for ${sourceInfo.project}/${sourceInfo.beadId} (answer provided)`);
    } else {
      console.log(`🔄 Dispatching ${agent} for ${sourceInfo.project}/${sourceInfo.beadId}`);
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
    const project = this.projects.get(work.workItem.project);
    if (!project) {
      throw new Error(`Project not found: ${work.workItem.project}`);
    }

    // Build prompt for the agent
    const workflowContext = getWorkflowContext(work.workflowStepId);
    const prompt = formatAgentPrompt({
      taskTitle: work.workItem.title,
      taskDescription: work.workItem.description,
      workflowContext,
      agentRole: this.getAgentRole(work.agent),
    });

    await this.notifier.notifyProgress(work, `Running ${work.agent} agent`);

    try {
      // Run the agent
      const result = await this.agentRunner.run({
        prompt,
        cwd: work.worktreePath,
        maxTurns: this.MAX_AGENT_TURNS,
        onOutput: (_text) => {
          // Could stream to notifier here
        },
        onToolUse: (_tool, _input) => {
          // Could log tool use here
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

      // Detect turn limit hit — agent used all available turns without finishing
      if (result.turns >= this.MAX_AGENT_TURNS) {
        console.warn(
          `⚠️ Agent ${work.agent} hit turn limit (${result.turns}/${this.MAX_AGENT_TURNS}) — marking BLOCKED`
        );
        await this.notifier.notifyProgress(
          work,
          `Agent hit turn limit (${result.turns} turns) — needs human intervention`
        );
        const blockedHandoff = {
          next_agent: "BLOCKED",
          context: `Agent exhausted all ${result.turns} turns without completing. ` +
            `Output tail: ${result.output.slice(-500)}`,
        };
        await this.processHandoff(work, blockedHandoff, result.costUsd);
        return;
      }

      // Get handoff (trust but verify)
      const handoff = await getHandoff(
        result.output,
        result.sessionId,
        work.worktreePath,
        this.agentRunner
      );

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
    await this.notifier.notifyProgress(work, `Resuming ${work.agent} agent with answer`);

    try {
      // Resume the agent session with the answer
      const result = await this.agentRunner.resumeWithAnswer(sessionId, answer, {
        cwd: work.worktreePath,
        maxTurns: this.MAX_AGENT_TURNS,
        onOutput: (_text) => {
          // Could stream to notifier here
        },
        onToolUse: (_tool, _input) => {
          // Could log tool use here
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

      // Check for another pending question
      if (result.pendingQuestion) {
        await this.handlePendingQuestion(work, result);
        return;
      }

      // Detect turn limit hit
      if (result.turns >= this.MAX_AGENT_TURNS) {
        console.warn(
          `⚠️ Agent ${work.agent} hit turn limit (${result.turns}/${this.MAX_AGENT_TURNS}) — marking BLOCKED`
        );
        await this.notifier.notifyProgress(
          work,
          `Agent hit turn limit (${result.turns} turns) — needs human intervention`
        );
        const blockedHandoff = {
          next_agent: "BLOCKED",
          context: `Agent exhausted all ${result.turns} turns without completing. ` +
            `Output tail: ${result.output.slice(-500)}`,
        };
        await this.processHandoff(work, blockedHandoff, result.costUsd);
        return;
      }

      // Get handoff (trust but verify)
      const handoff = await getHandoff(
        result.output,
        result.sessionId,
        work.worktreePath,
        this.agentRunner
      );

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

    // Remove from active work (paused until answered)
    this.state = removeActiveWork(this.state, work.workItem.id);

    await this.notifier.notifyQuestion(questionBead.id, questionData);
    console.log(`❓ Question pending: ${questionBead.id}`);
  }

  /**
   * Processes a handoff from an agent
   */
  private async processHandoff(
    work: ActiveWork,
    handoff: { next_agent: string; pr_number?: number; ci_status?: string; context: string },
    _stepCost: number
  ): Promise<void> {
    console.log(`🔀 Handoff: ${work.agent} → ${handoff.next_agent}`);

    // Complete the current step
    completeStep(work.workflowStepId, handoff.context);

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
      console.log(`   Next step created for ${handoff.next_agent}`);
    } else {
      console.error(`Invalid next agent: ${handoff.next_agent}, marking blocked`);
      await this.markWorkflowBlocked(work, `Invalid agent: ${handoff.next_agent}`);
    }
  }

  /**
   * Completes a workflow successfully
   */
  private async completeWorkflowSuccess(work: ActiveWork, reason: string): Promise<void> {
    completeWorkflow(work.workflowEpicId, "done", reason);

    // Get the source bead info from the workflow epic (not from workItem.id which may be a step ID)
    const sourceInfo = getSourceBeadInfo(work.workflowEpicId);
    if (!sourceInfo) {
      console.warn(`Could not find source bead info for epic ${work.workflowEpicId}`);
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
        console.log(`   Closed source bead: ${sourceInfo.project}/${sourceInfo.beadId}`);
      } catch (err) {
        console.warn(`Failed to close source bead ${sourceInfo.beadId}: ${err}`);
      }
    }

    // Clean up worktree
    try {
      removeWorktree(work.workItem.project, work.workItem.id);
    } catch {
      // May fail if branch not merged yet
    }

    await this.notifier.notifyComplete(work, "done");
    console.log(`✅ Workflow complete: ${work.workItem.project}/${work.workItem.id}`);
  }

  /**
   * Marks a workflow as blocked
   */
  private async markWorkflowBlocked(work: ActiveWork, reason: string): Promise<void> {
    completeWorkflow(work.workflowEpicId, "blocked", reason);
    await this.notifier.notifyComplete(work, "blocked");
    console.log(`🚫 Workflow blocked: ${work.workItem.project}/${work.workItem.id} - ${reason}`);
  }

  /**
   * Handles an authentication error - stops the dispatcher entirely
   *
   * Auth errors require human intervention (re-login, API key refresh)
   * so we stop all work and notify loudly.
   */
  private async handleAuthError(work: ActiveWork, message: string): Promise<void> {
    console.error("\n" + "=".repeat(60));
    console.error("🔐 AUTHENTICATION ERROR - STOPPING DISPATCHER");
    console.error("=".repeat(60));
    console.error(`\nError: ${message}`);
    console.error("\nAll agents have been stopped. Please fix authentication:");
    console.error("  1. Run 'whs claude-login' to refresh OAuth token, or");
    console.error("  2. Set ANTHROPIC_API_KEY in ~/work/whs-orchestrator/.whs/.env");
    console.error("\nThen restart the dispatcher with 'whs start'");
    console.error("=".repeat(60) + "\n");

    // Notify about the auth error
    await this.notifier.notifyError(work, new Error(`Authentication failed: ${message}`));

    // Mark current work as blocked
    await this.markWorkflowBlocked(work, `Authentication error: ${message}`);
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
      console.log("⚠️  Rate limit hit, pausing dispatcher");
      await this.notifier.notifyRateLimit(err as Error);
      this.pause();
      // Keep work item active for retry
      return;
    }

    console.error(`❌ Agent error for ${work.workItem.id}: ${message}`);
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
      console.log("⚠️  Rate limit detected, pausing");
      await this.notifier.notifyRateLimit(err as Error);
      this.pause();
      return;
    }

    console.error(`Error dispatching ${work.id}:`, err);
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
  private getAgentRole(agent: string): string {
    const roles: Record<string, string> = {
      implementation: "You are a senior software engineer. Implement the requested changes, create a PR when ready.",
      quality_review: "You are a code reviewer. Review the PR, check CI status, and decide if it's ready to merge.",
      release_manager: "You are a release manager. Merge approved PRs and handle any merge conflicts.",
      ux_specialist: "You are a UX specialist. Implement UI/UX changes following design best practices.",
      architect: "You are a software architect. Make technical decisions and unblock complex issues.",
      planner: "You are a technical planner. Break down the task into implementable subtasks.",
    };
    return roles[agent] || `You are the ${agent} agent.`;
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
  } {
    const orchestratorPath = expandPath(this.config.orchestratorPath);
    const pendingQuestions = beads.listPendingQuestions(orchestratorPath);

    return {
      active: [...this.state.activeWork.values()],
      pendingQuestionCount: pendingQuestions.length,
      paused: this.state.paused,
    };
  }
}
