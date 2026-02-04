/**
 * State Persistence - Crash recovery support
 *
 * Manages ~/.whs/state.json for tracking active work and pending questions.
 * State is saved after every significant change to enable crash recovery.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { ensureConfigDir, getConfigDir } from "./config.js";
import type { ActiveWork, PendingQuestion, AnsweredQuestion } from "./types.js";

const STATE_FILE = "state.json";
const LOCK_FILE = "dispatcher.lock";

/**
 * Serializable version of ActiveWork (dates as ISO strings)
 */
interface SerializedActiveWork {
  workItem: ActiveWork["workItem"];
  workflowEpicId: string;
  workflowStepId: string;
  sessionId: string;
  worktreePath: string;
  startedAt: string; // ISO date string
  agent: string;
  costSoFar: number;
}

/**
 * Serializable version of PendingQuestion (dates as ISO strings)
 */
interface SerializedPendingQuestion {
  id: string;
  workItemId: string;
  project: string;
  workflowEpicId: string;
  workflowStepId: string;
  sessionId: string;
  worktreePath: string;
  questions: PendingQuestion["questions"];
  askedAt: string; // ISO date string
  context: string;
}

/**
 * Serializable version of AnsweredQuestion (dates as ISO strings)
 */
interface SerializedAnsweredQuestion extends SerializedPendingQuestion {
  answer: string;
  answeredAt: string; // ISO date string
}

/**
 * Persisted state structure
 */
interface PersistedState {
  version: number;
  activeWork: Record<string, SerializedActiveWork>;
  pendingQuestions: Record<string, SerializedPendingQuestion>;
  answeredQuestions: Record<string, SerializedAnsweredQuestion>;
  paused: boolean;
  lastUpdated: string; // ISO date string
}

/**
 * Runtime state structure (with Date objects)
 */
export interface DispatcherState {
  activeWork: Map<string, ActiveWork>;
  pendingQuestions: Map<string, PendingQuestion>;
  answeredQuestions: Map<string, AnsweredQuestion>;
  paused: boolean;
  lastUpdated: Date;
}

const CURRENT_VERSION = 1;

/**
 * Gets the path to the state file
 */
export function getStatePath(): string {
  return join(getConfigDir(), STATE_FILE);
}

/**
 * Creates an empty state
 */
function createEmptyState(): DispatcherState {
  return {
    activeWork: new Map(),
    pendingQuestions: new Map(),
    answeredQuestions: new Map(),
    paused: false,
    lastUpdated: new Date(),
  };
}

/**
 * Serializes ActiveWork for persistence
 */
function serializeActiveWork(work: ActiveWork): SerializedActiveWork {
  return {
    ...work,
    startedAt: work.startedAt.toISOString(),
  };
}

/**
 * Deserializes ActiveWork from persistence
 */
function deserializeActiveWork(data: SerializedActiveWork): ActiveWork {
  return {
    ...data,
    startedAt: new Date(data.startedAt),
  };
}

/**
 * Serializes PendingQuestion for persistence
 */
function serializePendingQuestion(
  question: PendingQuestion
): SerializedPendingQuestion {
  return {
    ...question,
    askedAt: question.askedAt.toISOString(),
  };
}

/**
 * Deserializes PendingQuestion from persistence
 */
function deserializePendingQuestion(
  data: SerializedPendingQuestion
): PendingQuestion {
  return {
    ...data,
    askedAt: new Date(data.askedAt),
  };
}

/**
 * Serializes AnsweredQuestion for persistence
 */
function serializeAnsweredQuestion(
  question: AnsweredQuestion
): SerializedAnsweredQuestion {
  return {
    ...question,
    askedAt: question.askedAt.toISOString(),
    answeredAt: question.answeredAt.toISOString(),
  };
}

/**
 * Deserializes AnsweredQuestion from persistence
 */
function deserializeAnsweredQuestion(
  data: SerializedAnsweredQuestion
): AnsweredQuestion {
  return {
    ...data,
    askedAt: new Date(data.askedAt),
    answeredAt: new Date(data.answeredAt),
  };
}

/**
 * Loads state from ~/.whs/state.json
 * Returns empty state if file doesn't exist or is invalid
 */
export function loadState(): DispatcherState {
  ensureConfigDir();
  const statePath = getStatePath();

  if (!existsSync(statePath)) {
    return createEmptyState();
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(content) as PersistedState;

    // Version check for future migrations
    if (parsed.version !== CURRENT_VERSION) {
      console.warn(
        `State file version mismatch (got ${parsed.version}, expected ${CURRENT_VERSION}). Starting fresh.`
      );
      return createEmptyState();
    }

    // Deserialize into runtime state
    const activeWork = new Map<string, ActiveWork>();
    for (const [id, data] of Object.entries(parsed.activeWork)) {
      activeWork.set(id, deserializeActiveWork(data));
    }

    const pendingQuestions = new Map<string, PendingQuestion>();
    for (const [id, data] of Object.entries(parsed.pendingQuestions)) {
      pendingQuestions.set(id, deserializePendingQuestion(data));
    }

    const answeredQuestions = new Map<string, AnsweredQuestion>();
    for (const [id, data] of Object.entries(parsed.answeredQuestions || {})) {
      answeredQuestions.set(id, deserializeAnsweredQuestion(data));
    }

    return {
      activeWork,
      pendingQuestions,
      answeredQuestions,
      paused: parsed.paused ?? false,
      lastUpdated: new Date(parsed.lastUpdated),
    };
  } catch (err) {
    console.warn(
      `Failed to load state from ${statePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return createEmptyState();
  }
}

/**
 * Saves state to ~/.whs/state.json
 */
export function saveState(state: DispatcherState): void {
  ensureConfigDir();
  const statePath = getStatePath();

  // Serialize Maps to Records
  const activeWork: Record<string, SerializedActiveWork> = {};
  for (const [id, work] of state.activeWork) {
    activeWork[id] = serializeActiveWork(work);
  }

  const pendingQuestions: Record<string, SerializedPendingQuestion> = {};
  for (const [id, question] of state.pendingQuestions) {
    pendingQuestions[id] = serializePendingQuestion(question);
  }

  const answeredQuestions: Record<string, SerializedAnsweredQuestion> = {};
  for (const [id, question] of state.answeredQuestions) {
    answeredQuestions[id] = serializeAnsweredQuestion(question);
  }

  const persisted: PersistedState = {
    version: CURRENT_VERSION,
    activeWork,
    pendingQuestions,
    answeredQuestions,
    paused: state.paused,
    lastUpdated: new Date().toISOString(),
  };

  try {
    writeFileSync(statePath, JSON.stringify(persisted, null, 2) + "\n", "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to save state to ${statePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Adds active work to state and persists
 */
export function addActiveWork(
  state: DispatcherState,
  work: ActiveWork
): DispatcherState {
  const newState: DispatcherState = {
    ...state,
    activeWork: new Map(state.activeWork),
    lastUpdated: new Date(),
  };
  newState.activeWork.set(work.workItem.id, work);
  saveState(newState);
  return newState;
}

/**
 * Removes active work from state and persists
 */
export function removeActiveWork(
  state: DispatcherState,
  workItemId: string
): DispatcherState {
  const newState: DispatcherState = {
    ...state,
    activeWork: new Map(state.activeWork),
    lastUpdated: new Date(),
  };
  newState.activeWork.delete(workItemId);
  saveState(newState);
  return newState;
}

/**
 * Updates active work in state and persists
 */
export function updateActiveWork(
  state: DispatcherState,
  workItemId: string,
  updates: Partial<ActiveWork>
): DispatcherState {
  const existing = state.activeWork.get(workItemId);
  if (!existing) {
    return state;
  }

  const newState: DispatcherState = {
    ...state,
    activeWork: new Map(state.activeWork),
    lastUpdated: new Date(),
  };
  newState.activeWork.set(workItemId, { ...existing, ...updates });
  saveState(newState);
  return newState;
}

/**
 * Adds a pending question to state and persists
 */
export function addPendingQuestion(
  state: DispatcherState,
  question: PendingQuestion
): DispatcherState {
  const newState: DispatcherState = {
    ...state,
    pendingQuestions: new Map(state.pendingQuestions),
    lastUpdated: new Date(),
  };
  newState.pendingQuestions.set(question.id, question);
  saveState(newState);
  return newState;
}

/**
 * Removes a pending question from state and persists
 */
export function removePendingQuestion(
  state: DispatcherState,
  questionId: string
): DispatcherState {
  const newState: DispatcherState = {
    ...state,
    pendingQuestions: new Map(state.pendingQuestions),
    lastUpdated: new Date(),
  };
  newState.pendingQuestions.delete(questionId);
  saveState(newState);
  return newState;
}

/**
 * Gets a pending question by ID
 */
export function getPendingQuestion(
  state: DispatcherState,
  questionId: string
): PendingQuestion | undefined {
  return state.pendingQuestions.get(questionId);
}

/**
 * Answers a pending question - moves it from pending to answered
 */
export function answerQuestion(
  state: DispatcherState,
  questionId: string,
  answer: string
): DispatcherState {
  const question = state.pendingQuestions.get(questionId);
  if (!question) {
    throw new Error(`Question not found: ${questionId}`);
  }

  const answeredQuestion: AnsweredQuestion = {
    ...question,
    answer,
    answeredAt: new Date(),
  };

  const newState: DispatcherState = {
    ...state,
    pendingQuestions: new Map(state.pendingQuestions),
    answeredQuestions: new Map(state.answeredQuestions),
    lastUpdated: new Date(),
  };
  newState.pendingQuestions.delete(questionId);
  newState.answeredQuestions.set(questionId, answeredQuestion);
  saveState(newState);
  return newState;
}

/**
 * Gets all answered questions
 */
export function getAnsweredQuestions(
  state: DispatcherState
): AnsweredQuestion[] {
  return [...state.answeredQuestions.values()];
}

/**
 * Removes an answered question from state (after processing)
 */
export function removeAnsweredQuestion(
  state: DispatcherState,
  questionId: string
): DispatcherState {
  const newState: DispatcherState = {
    ...state,
    answeredQuestions: new Map(state.answeredQuestions),
    lastUpdated: new Date(),
  };
  newState.answeredQuestions.delete(questionId);
  saveState(newState);
  return newState;
}

/**
 * Sets the paused state and persists
 */
export function setPaused(
  state: DispatcherState,
  paused: boolean
): DispatcherState {
  const newState: DispatcherState = {
    ...state,
    paused,
    lastUpdated: new Date(),
  };
  saveState(newState);
  return newState;
}

/**
 * Clears all state (for testing or reset)
 */
export function clearState(): DispatcherState {
  const state = createEmptyState();
  saveState(state);
  return state;
}

/**
 * Gets a summary of the current state for display
 */
export function getStateSummary(state: DispatcherState): {
  activeWorkCount: number;
  pendingQuestionsCount: number;
  paused: boolean;
  activeProjects: string[];
  oldestWork: Date | null;
} {
  const activeProjects = new Set<string>();
  let oldestWork: Date | null = null;

  for (const work of state.activeWork.values()) {
    activeProjects.add(work.workItem.project);
    if (!oldestWork || work.startedAt < oldestWork) {
      oldestWork = work.startedAt;
    }
  }

  return {
    activeWorkCount: state.activeWork.size,
    pendingQuestionsCount: state.pendingQuestions.size,
    paused: state.paused,
    activeProjects: [...activeProjects],
    oldestWork,
  };
}

// ============================================================
// Lock File Management
// ============================================================

/**
 * Gets the path to the lock file
 */
export function getLockPath(): string {
  return join(getConfigDir(), LOCK_FILE);
}

/**
 * Lock file content structure
 */
interface LockInfo {
  pid: number;
  startedAt: string;
}

/**
 * Attempts to acquire the dispatcher lock.
 * Returns true if lock acquired, false if another dispatcher is running.
 */
export function acquireLock(): boolean {
  ensureConfigDir();
  const lockPath = getLockPath();

  // Check if lock exists
  if (existsSync(lockPath)) {
    try {
      const content = readFileSync(lockPath, "utf-8");
      const lockInfo: LockInfo = JSON.parse(content);

      // Check if the process is still running
      try {
        process.kill(lockInfo.pid, 0); // Signal 0 = check if process exists
        // Process exists, lock is held
        return false;
      } catch {
        // Process doesn't exist, stale lock - remove it
        unlinkSync(lockPath);
      }
    } catch {
      // Invalid lock file, remove it
      unlinkSync(lockPath);
    }
  }

  // Create lock file
  const lockInfo: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2));
  return true;
}

/**
 * Releases the dispatcher lock
 */
export function releaseLock(): void {
  const lockPath = getLockPath();
  if (existsSync(lockPath)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore errors on cleanup
    }
  }
}

/**
 * Gets info about the current lock holder (if any)
 */
export function getLockInfo(): LockInfo | null {
  const lockPath = getLockPath();
  if (!existsSync(lockPath)) {
    return null;
  }

  try {
    const content = readFileSync(lockPath, "utf-8");
    const lockInfo: LockInfo = JSON.parse(content);

    // Verify process is still running
    try {
      process.kill(lockInfo.pid, 0);
      return lockInfo;
    } catch {
      // Process doesn't exist, stale lock
      return null;
    }
  } catch {
    return null;
  }
}
