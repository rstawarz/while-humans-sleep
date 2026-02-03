/**
 * Core types for While Humans Sleep dispatcher
 */

// === Project Configuration ===

export interface Project {
  name: string;
  repoPath: string;
  baseBranch: string;
  agentsPath: string;
  beadsMode: "committed" | "stealth";
}

export interface Config {
  projects: Project[];
  orchestratorPath: string;
  concurrency: {
    maxTotal: number;
    maxPerProject: number;
  };
  notifier: "cli" | "slack";
  slack?: {
    token: string;
    channelId: string;
  };
}

// === Work Items ===

export interface WorkItem {
  id: string;              // bead id, e.g., "bd-a3f8"
  project: string;         // project name
  title: string;
  description: string;
  priority: number;        // 0-4, where 0 is critical
  type: "epic" | "task" | "bug" | "planning";
  status: "open" | "in_progress" | "blocked" | "closed";
  dependencies: string[];
}

export interface ActiveWork {
  workItem: WorkItem;
  workflowEpicId: string;  // orchestrator bead epic
  workflowStepId: string;  // current step bead
  sessionId: string;       // Claude SDK session
  worktreePath: string;
  startedAt: Date;
  agent: string;
  costSoFar: number;
}

// === Handoff ===

export interface Handoff {
  next_agent: string;      // agent name, "DONE", or "BLOCKED"
  pr_number?: number;
  ci_status?: "pending" | "passed" | "failed";
  context: string;
}

// === Questions ===

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingQuestion {
  id: string;
  workItemId: string;
  project: string;
  workflowEpicId: string;
  workflowStepId: string;
  sessionId: string;
  worktreePath: string;
  questions: Question[];
  askedAt: Date;
  context: string;
}

// === Notifier ===

export interface Notifier {
  notifyQuestion(question: PendingQuestion): Promise<void>;
  notifyProgress(work: ActiveWork, message: string): Promise<void>;
  notifyComplete(work: ActiveWork, result: "done" | "blocked"): Promise<void>;
  notifyError(work: ActiveWork, error: Error): Promise<void>;
  notifyRateLimit(error: Error): Promise<void>;
}

// === Metrics ===

export interface WorkflowRun {
  id: string;
  project: string;
  sourceBead: string;
  startedAt: Date;
  completedAt?: Date;
  status: "running" | "done" | "blocked";
  totalCost: number;
}

export interface StepRun {
  id: string;
  workflowId: string;
  agent: string;
  startedAt: Date;
  completedAt?: Date;
  cost: number;
  outcome?: string;
}
