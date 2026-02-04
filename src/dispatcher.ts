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
  getWorkflowForSource,
} from "./workflow.js";
import { ensureWorktree, removeWorktree } from "./worktree.js";
import { runAgent, formatAgentPrompt, resumeWithAnswer } from "./agent-runner.js";
import { getHandoff, isValidAgent } from "./handoff.js";
import type { Bead } from "./beads/types.js";

export class Dispatcher {
  private projects: Map<string, Project>;
  private state: DispatcherState;
  private notifier: Notifier;
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

  constructor(config: Config, notifier: Notifier) {
    this.config = config;
    this.projects = new Map(config.projects.map((p) => [p.name, p]));
    this.notifier = notifier;

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

    // 1. Poll orchestrator beads for ready workflow steps
    // Note: Steps blocked by question beads won't appear in ready list
    const workflowSteps = this.getReadyWorkflowSteps();
    for (const step of workflowSteps) {
      if (this.isAtCapacity()) break;
      if (this.state.activeWork.has(step.id)) continue;

      // Dispatch asynchronously and track the promise
      const agentPromise = this.dispatchWorkflowStep(step)
        .catch((err) => {
          this.handleDispatchError(step, err);
        })
        .finally(() => {
          this.runningAgents.delete(step.id);
        });
      this.runningAgents.set(step.id, agentPromise);
    }

    // 3. If under capacity, poll project beads for new work
    if (this.state.activeWork.size < this.config.concurrency.maxTotal) {
      const newWork = await this.pollProjectBacklogs();
      const next = this.pickHighestPriority(newWork);
      if (next) {
        const workflowPromise = this.startNewWorkflow(next)
          .catch((err) => {
            console.error(`Failed to start workflow for ${next.id}:`, err);
          })
          .finally(() => {
            this.runningAgents.delete(next.id);
          });
        this.runningAgents.set(next.id, workflowPromise);
      }
    }
  }

  private isAtCapacity(): boolean {
    return this.state.activeWork.size >= this.config.concurrency.maxTotal;
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
   * Picks the highest priority work item
   */
  private pickHighestPriority(items: WorkItem[]): WorkItem | undefined {
    if (items.length === 0) return undefined;
    // Beads returns items sorted by priority, take first
    return items[0];
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

    console.log(`🔄 Dispatching ${agent} for ${sourceInfo.project}/${sourceInfo.beadId}`);

    // Ensure worktree exists
    const worktreePath = ensureWorktree(sourceInfo.project, sourceInfo.beadId, {
      baseBranch: project.baseBranch,
    });

    // Use the epic ID we already fetched
    const epicId = epic.id;

    // Mark step as in progress
    markStepInProgress(step.id);

    // Create active work entry
    const activeWork: ActiveWork = {
      workItem: {
        ...step,
        project: sourceInfo.project,
      },
      workflowEpicId: epicId,
      workflowStepId: step.id,
      sessionId: "",
      worktreePath,
      startedAt: new Date(),
      agent,
      costSoFar: 0,
    };
    this.state = addActiveWork(this.state, activeWork);

    // Run the agent
    await this.runAgentStep(activeWork);
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
      const result = await runAgent(prompt, {
        cwd: work.worktreePath,
        maxTurns: 50,
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

      // Check for pending question
      if (result.pendingQuestion) {
        await this.handlePendingQuestion(work, result);
        return;
      }

      // Get handoff (trust but verify)
      const handoff = await getHandoff(
        result.output,
        result.sessionId,
        work.worktreePath
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

    // Close the source bead in the project
    const project = this.projects.get(work.workItem.project);
    if (project) {
      try {
        beads.close(
          work.workItem.id,
          `Completed by WHS workflow`,
          expandPath(project.repoPath)
        );
      } catch (err) {
        console.warn(`Failed to close source bead: ${err}`);
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
   * Answers a pending question bead and resumes the agent session
   *
   * Flow:
   * 1. Mark the blocked step as in_progress (prevents race)
   * 2. Answer and close the question bead (unblocks step)
   * 3. Resume the agent session with the answer
   * 4. Process the result (may create new question or handoff)
   */
  async answerQuestion(questionId: string, answer: string): Promise<void> {
    const orchestratorPath = expandPath(this.config.orchestratorPath);

    // Get the question bead
    // Questions are stored as tasks with "whs:question" label
    const questionBead = beads.show(questionId, orchestratorPath);
    const isQuestion = questionBead?.labels?.includes("whs:question");
    if (!questionBead || !isQuestion || questionBead.status !== "open") {
      throw new Error(`Question not found or already answered: ${questionId}`);
    }

    // Parse question data from description
    const questionData = beads.parseQuestionData(questionBead);
    console.log(`📝 Answering question ${questionId}`);

    // 1. Mark the blocked step as in_progress FIRST (prevents race condition)
    markStepInProgress(questionData.metadata.step_id);

    // 2. Answer and close the question bead
    beads.answerQuestion(questionId, answer, orchestratorPath);

    // 3. Resume the agent session with the answer
    const result = await resumeWithAnswer(questionData.metadata.session_id, answer, {
      cwd: questionData.metadata.worktree,
      maxTurns: 50,
    });

    // 4. Recreate active work entry
    const workItem: WorkItem = {
      id: questionData.metadata.step_id, // Use step_id as work item id
      project: questionData.metadata.project,
      title: "",
      description: "",
      priority: 2,
      type: "task",
      status: "in_progress",
      labels: [],
      dependencies: [],
    };

    const work: ActiveWork = {
      workItem,
      workflowEpicId: questionData.metadata.epic_id,
      workflowStepId: questionData.metadata.step_id,
      sessionId: result.sessionId,
      worktreePath: questionData.metadata.worktree,
      startedAt: new Date(),
      agent: "unknown", // Would need to extract from step
      costSoFar: result.costUsd,
    };

    // Check for another question
    if (result.pendingQuestion) {
      await this.handlePendingQuestion(work, result);
      return;
    }

    // Get handoff and process
    const handoff = await getHandoff(
      result.output,
      result.sessionId,
      questionData.metadata.worktree
    );

    await this.processHandoff(work, handoff, result.costUsd);
  }

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
