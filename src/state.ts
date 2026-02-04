/**
 * State Persistence - Crash recovery support
 *
 * Manages ~/.whs/state.json for tracking active work.
 * State is saved after every significant change to enable crash recovery.
 *
 * Note: Questions are now tracked as beads in the orchestrator, not in state.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { ensureConfigDir, getConfigDir } from "./config.js";
import type { ActiveWork } from "./types.js";

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
 * Persisted state structure
 */
interface PersistedState {
  version: number;
  activeWork: Record<string, SerializedActiveWork>;
  paused: boolean;
  lastUpdated: string; // ISO date string
}

/**
 * Runtime state structure (with Date objects)
 */
export interface DispatcherState {
  activeWork: Map<string, ActiveWork>;
  paused: boolean;
  lastUpdated: Date;
}

const CURRENT_VERSION = 2; // Bumped from 1 - questions moved to beads

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

    // Version check - if old version, start fresh (questions moved to beads)
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

    return {
      activeWork,
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

  const persisted: PersistedState = {
    version: CURRENT_VERSION,
    activeWork,
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
