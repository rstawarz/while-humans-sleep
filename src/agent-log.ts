/**
 * Agent Log — structured activity logging for agent steps
 *
 * Writes compact JSONL log entries during agent execution so that
 * `/status <step>` can show recent activity. Logs live at
 * `.whs/logs/{stepId}.jsonl` and are cleaned up on dispatcher start.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { getConfigDir } from "./config.js";

const LOGS_DIR = "logs";
const MAX_TEXT_LENGTH = 200;
const MAX_INPUT_LENGTH = 200;

// === Types ===

export interface AgentLogEvent {
  /** Unix timestamp in seconds */
  t: number;
  type: "start" | "tool" | "text" | "end";
  /** Agent name (start/end only) */
  agent?: string;
  /** Step ID (start only) */
  step?: string;
  /** Tool name (tool only) */
  name?: string;
  /** Tool input summary (tool only) */
  input?: string;
  /** Text output (text only) */
  text?: string;
  /** Handoff outcome (end only) */
  outcome?: string;
  /** Step cost (end only) */
  cost?: number;
}

// === Public API ===

/**
 * Returns the logs directory path, creating it if needed.
 */
export function getLogsDir(): string {
  const configDir = getConfigDir();
  const logsDir = join(configDir, LOGS_DIR);
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
}

/**
 * Returns the log file path for a step.
 */
export function getAgentLogPath(stepId: string): string {
  return join(getLogsDir(), `${stepId}.jsonl`);
}

/**
 * Write a log entry for an agent step.
 *
 * Appends a single JSONL line. Designed to be called from
 * the dispatcher's onOutput/onToolUse callbacks.
 */
export function logAgentEvent(stepId: string, event: Omit<AgentLogEvent, "t">): void {
  const entry: AgentLogEvent = {
    t: Math.floor(Date.now() / 1000),
    ...event,
  };

  // Truncate text/input to keep logs compact
  if (entry.text && entry.text.length > MAX_TEXT_LENGTH) {
    entry.text = entry.text.slice(0, MAX_TEXT_LENGTH) + "...";
  }
  if (entry.input && entry.input.length > MAX_INPUT_LENGTH) {
    entry.input = entry.input.slice(0, MAX_INPUT_LENGTH) + "...";
  }

  try {
    const logPath = getAgentLogPath(stepId);
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // Best effort — don't let logging failures affect agent execution
  }
}

/**
 * Read recent log entries for a step.
 *
 * Returns the last `limit` entries (default 20).
 */
export function readAgentLog(stepId: string, limit: number = 20): AgentLogEvent[] {
  const logPath = getAgentLogPath(stepId);

  try {
    if (!existsSync(logPath)) return [];

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Take the last N lines
    const recent = lines.slice(-limit);

    return recent.map((line) => JSON.parse(line) as AgentLogEvent);
  } catch {
    return [];
  }
}

/**
 * Delete all log files.
 *
 * Called on dispatcher start to clean up logs from previous sessions.
 */
export function cleanAllLogs(): void {
  try {
    const logsDir = getLogsDir();
    const files = readdirSync(logsDir);
    for (const file of files) {
      if (file.endsWith(".jsonl")) {
        unlinkSync(join(logsDir, file));
      }
    }
  } catch {
    // Best effort
  }
}
