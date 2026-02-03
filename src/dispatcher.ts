/**
 * Main Dispatcher - orchestrates agent work across projects
 */

import type {
  Config,
  Project,
  WorkItem,
  ActiveWork,
  PendingQuestion,
  Handoff,
  Notifier,
} from "./types.js";

// TODO: Import from Claude Agent SDK when available
// import { query, ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";

export class Dispatcher {
  private projects: Map<string, Project>;
  private activeWork: Map<string, ActiveWork>;
  private pendingQuestions: Map<string, PendingQuestion>;
  private notifier: Notifier;
  private paused: boolean = false;
  private running: boolean = false;

  private readonly config: Config;

  constructor(config: Config, notifier: Notifier) {
    this.config = config;
    this.projects = new Map(config.projects.map((p) => [p.name, p]));
    this.activeWork = new Map();
    this.pendingQuestions = new Map();
    this.notifier = notifier;
  }

  async start(): Promise<void> {
    console.log("🌙 While Humans Sleep - Starting dispatcher");
    console.log(`   Projects: ${[...this.projects.keys()].join(", ")}`);
    console.log(`   Max concurrent: ${this.config.concurrency.maxTotal}`);
    console.log("");

    this.running = true;

    while (this.running) {
      if (!this.paused) {
        await this.tick();
      }
      await this.sleep(5000);
    }
  }

  async stop(): Promise<void> {
    console.log("🛑 Stopping dispatcher...");
    this.running = false;
  }

  pause(): void {
    this.paused = true;
    console.log("⏸️  Dispatcher paused");
  }

  resume(): void {
    this.paused = false;
    console.log("▶️  Dispatcher resumed");
  }

  private async tick(): Promise<void> {
    // 1. Process any answered questions
    // TODO: Check for answers and resume sessions

    // 2. Poll orchestrator beads for ready workflow steps
    const workflowSteps = await this.getReadyWorkflowSteps();
    for (const step of workflowSteps) {
      if (this.isAtCapacity()) break;
      if (this.activeWork.has(step.id)) continue;

      this.dispatchWorkflowStep(step).catch((err) => {
        this.handleDispatchError(step, err);
      });
    }

    // 3. If under capacity, poll project beads for new work
    if (this.activeWork.size < this.config.concurrency.maxTotal) {
      const newWork = await this.pollProjectBacklogs();
      const next = this.pickHighestPriority(newWork);
      if (next) {
        this.startWorkflow(next).catch((err) => {
          console.error(`Failed to start workflow for ${next.id}:`, err);
        });
      }
    }
  }

  private isAtCapacity(): boolean {
    return this.activeWork.size >= this.config.concurrency.maxTotal;
  }

  private async getReadyWorkflowSteps(): Promise<WorkItem[]> {
    // TODO: Query orchestrator beads for ready workflow steps
    // bd ready --type task --json in orchestratorPath
    return [];
  }

  private async pollProjectBacklogs(): Promise<WorkItem[]> {
    const items: WorkItem[] = [];

    for (const [name, project] of this.projects) {
      // Check per-project concurrency limit
      const activeForProject = [...this.activeWork.values()].filter(
        (w) => w.workItem.project === name
      ).length;

      if (activeForProject >= this.config.concurrency.maxPerProject) {
        continue;
      }

      // TODO: Run bd ready --json in project.repoPath
      // Parse results and add to items
    }

    return items;
  }

  private pickHighestPriority(items: WorkItem[]): WorkItem | undefined {
    if (items.length === 0) return undefined;
    // Already sorted by priority from beads, just take first
    return items[0];
  }

  private async startWorkflow(item: WorkItem): Promise<void> {
    console.log(`📋 Starting workflow for ${item.project}/${item.id}: ${item.title}`);

    // TODO:
    // 1. Create workflow epic in orchestrator beads
    // 2. Create first step (implementation or planner based on type)
    // 3. Create worktree
    // 4. Dispatch first agent
  }

  private async dispatchWorkflowStep(step: WorkItem): Promise<void> {
    // TODO:
    // 1. Get workflow context from step's bead description
    // 2. Get source bead info from workflow epic
    // 3. Ensure worktree exists
    // 4. Run agent via SDK
    // 5. Parse handoff from output (trust but verify)
    // 6. Update orchestrator beads with next step
  }

  private async handleDispatchError(work: WorkItem, err: unknown): Promise<void> {
    if (this.isRateLimitError(err)) {
      console.log("Rate limit detected");
      await this.notifier.notifyRateLimit(err as Error);
      this.pause();
      // TODO: Requeue the work item
      return;
    }

    console.error(`Error dispatching ${work.id}:`, err);
  }

  private isRateLimitError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
      message.includes("rate limit") ||
      message.includes("429") ||
      message.includes("too many requests")
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // === Public API for CLI ===

  async answerQuestion(questionId: string, answer: string): Promise<void> {
    const question = this.pendingQuestions.get(questionId);
    if (!question) {
      throw new Error(`Unknown question: ${questionId}`);
    }

    console.log(`📝 Answering question ${questionId}`);
    this.pendingQuestions.delete(questionId);

    // TODO:
    // 1. Resume session with answer
    // 2. Continue agent loop
  }

  getStatus(): {
    active: ActiveWork[];
    pending: PendingQuestion[];
    paused: boolean;
  } {
    return {
      active: [...this.activeWork.values()],
      pending: [...this.pendingQuestions.values()],
      paused: this.paused,
    };
  }
}
