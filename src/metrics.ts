/**
 * Metrics Database - SQLite for cost and execution tracking
 *
 * Stores workflow and step execution data for cost analysis
 * and performance monitoring.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";

const DEFAULT_WHS_DIR = join(homedir(), ".whs");
const DEFAULT_DB_PATH = join(DEFAULT_WHS_DIR, "metrics.db");

let customDbPath: string | null = null;

/**
 * Workflow run database record
 */
export interface WorkflowRunRecord {
  id: string;
  project: string;
  source_bead: string;
  started_at: string;
  completed_at: string | null;
  status: "running" | "done" | "blocked" | "error";
  total_cost: number;
}

/**
 * Step run database record
 */
export interface StepRunRecord {
  id: string;
  workflow_id: string;
  agent: string;
  started_at: string;
  completed_at: string | null;
  cost: number;
  turns: number;
  max_turns: number;
  outcome: string | null;
}

/**
 * Aggregated metrics by project
 */
export interface ProjectMetrics {
  project: string;
  workflow_count: number;
  step_count: number;
  total_cost: number;
  avg_cost_per_workflow: number;
}

/**
 * Aggregated metrics by agent type
 */
export interface AgentMetrics {
  agent: string;
  step_count: number;
  total_cost: number;
  avg_cost_per_step: number;
}

let db: Database.Database | null = null;

/**
 * Initializes the database with a custom path (useful for testing)
 */
export function initDb(dbPath?: string): void {
  if (db) {
    db.close();
    db = null;
  }
  customDbPath = dbPath || null;
}

/**
 * Gets or creates the database connection
 * Exported for use by other modules (e.g., Telegram message store)
 */
export function getMetricsDb(): Database.Database {
  if (db) return db;

  const dbPath = customDbPath || DEFAULT_DB_PATH;
  const dbDir = customDbPath ? null : DEFAULT_WHS_DIR;

  // Ensure directory exists (only for default path)
  if (dbDir && !existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma("journal_mode = WAL");

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      source_bead TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      total_cost REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS step_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      cost REAL NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      max_turns INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflow_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_project ON workflow_runs(project);
    CREATE INDEX IF NOT EXISTS idx_workflow_status ON workflow_runs(status);
    CREATE INDEX IF NOT EXISTS idx_step_workflow ON step_runs(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_step_agent ON step_runs(agent);
  `);

  // Migration: add turns columns if they don't exist (for existing DBs)
  try {
    db.exec(`ALTER TABLE step_runs ADD COLUMN turns INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE step_runs ADD COLUMN max_turns INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  return db;
}

/**
 * Records the start of a workflow
 */
export function recordWorkflowStart(
  id: string,
  project: string,
  sourceBead: string
): void {
  const database = getMetricsDb();
  const stmt = database.prepare(`
    INSERT INTO workflow_runs (id, project, source_bead, started_at, status, total_cost)
    VALUES (?, ?, ?, ?, 'running', 0)
  `);
  stmt.run(id, project, sourceBead, new Date().toISOString());
}

/**
 * Records the completion of a workflow
 */
export function recordWorkflowComplete(
  id: string,
  status: "done" | "blocked" | "error",
  totalCost?: number
): void {
  const database = getMetricsDb();

  // If totalCost not provided, sum from steps
  let cost = totalCost;
  if (cost === undefined) {
    const sumStmt = database.prepare(`
      SELECT COALESCE(SUM(cost), 0) as total FROM step_runs WHERE workflow_id = ?
    `);
    const result = sumStmt.get(id) as { total: number };
    cost = result.total;
  }

  const stmt = database.prepare(`
    UPDATE workflow_runs
    SET completed_at = ?, status = ?, total_cost = ?
    WHERE id = ?
  `);
  stmt.run(new Date().toISOString(), status, cost, id);
}

/**
 * Records the start of a step
 *
 * If the parent workflow doesn't exist in the DB (e.g. workflows started
 * before metrics were wired up), creates a placeholder workflow row to
 * satisfy the foreign key constraint.
 */
export function recordStepStart(
  id: string,
  workflowId: string,
  agent: string
): void {
  const database = getMetricsDb();

  // Ensure the parent workflow exists (handles pre-metrics workflows)
  const ensureWorkflow = database.prepare(`
    INSERT OR IGNORE INTO workflow_runs (id, project, source_bead, started_at, status, total_cost)
    VALUES (?, 'unknown', 'unknown', ?, 'running', 0)
  `);
  ensureWorkflow.run(workflowId, new Date().toISOString());

  // INSERT OR REPLACE handles retried steps that reuse the same step ID
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO step_runs (id, workflow_id, agent, started_at, cost)
    VALUES (?, ?, ?, ?, 0)
  `);
  stmt.run(id, workflowId, agent, new Date().toISOString());
}

/**
 * Records the completion of a step
 */
export function recordStepComplete(
  id: string,
  cost: number,
  outcome: string,
  turns?: number,
  maxTurns?: number
): void {
  const database = getMetricsDb();
  const stmt = database.prepare(`
    UPDATE step_runs
    SET completed_at = ?, cost = ?, outcome = ?, turns = ?, max_turns = ?
    WHERE id = ?
  `);
  stmt.run(new Date().toISOString(), cost, outcome, turns ?? 0, maxTurns ?? 0, id);
}

/**
 * Gets a workflow by ID
 */
export function getWorkflow(id: string): WorkflowRunRecord | null {
  const database = getMetricsDb();
  const stmt = database.prepare(`SELECT * FROM workflow_runs WHERE id = ?`);
  return (stmt.get(id) as WorkflowRunRecord) || null;
}

/**
 * Gets all steps for a workflow
 */
export function getWorkflowSteps(workflowId: string): StepRunRecord[] {
  const database = getMetricsDb();
  const stmt = database.prepare(`
    SELECT * FROM step_runs WHERE workflow_id = ? ORDER BY started_at
  `);
  return stmt.all(workflowId) as StepRunRecord[];
}

/**
 * Gets metrics aggregated by project
 */
export function getProjectMetrics(): ProjectMetrics[] {
  const database = getMetricsDb();
  const stmt = database.prepare(`
    SELECT
      w.project,
      COUNT(DISTINCT w.id) as workflow_count,
      COUNT(s.id) as step_count,
      COALESCE(SUM(s.cost), 0) as total_cost,
      CASE
        WHEN COUNT(DISTINCT w.id) > 0
        THEN COALESCE(SUM(s.cost), 0) / COUNT(DISTINCT w.id)
        ELSE 0
      END as avg_cost_per_workflow
    FROM workflow_runs w
    LEFT JOIN step_runs s ON s.workflow_id = w.id
    GROUP BY w.project
    ORDER BY total_cost DESC
  `);
  return stmt.all() as ProjectMetrics[];
}

/**
 * Gets metrics aggregated by agent type
 */
export function getAgentMetrics(): AgentMetrics[] {
  const database = getMetricsDb();
  const stmt = database.prepare(`
    SELECT
      agent,
      COUNT(*) as step_count,
      COALESCE(SUM(cost), 0) as total_cost,
      CASE
        WHEN COUNT(*) > 0
        THEN COALESCE(SUM(cost), 0) / COUNT(*)
        ELSE 0
      END as avg_cost_per_step
    FROM step_runs
    GROUP BY agent
    ORDER BY total_cost DESC
  `);
  return stmt.all() as AgentMetrics[];
}

/**
 * Gets recent workflows
 */
export function getRecentWorkflows(limit: number = 10): WorkflowRunRecord[] {
  const database = getMetricsDb();
  const stmt = database.prepare(`
    SELECT * FROM workflow_runs
    ORDER BY started_at DESC
    LIMIT ?
  `);
  return stmt.all(limit) as WorkflowRunRecord[];
}

/**
 * Gets running workflows
 */
export function getRunningWorkflows(): WorkflowRunRecord[] {
  const database = getMetricsDb();
  const stmt = database.prepare(`
    SELECT * FROM workflow_runs WHERE status = 'running' ORDER BY started_at
  `);
  return stmt.all() as WorkflowRunRecord[];
}

/**
 * Gets total cost across all workflows
 */
export function getTotalCost(): number {
  const database = getMetricsDb();
  const stmt = database.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM step_runs
  `);
  const result = stmt.get() as { total: number };
  return result.total;
}

/**
 * Gets cost for a specific time period
 */
export function getCostForPeriod(startDate: Date, endDate: Date): number {
  const database = getMetricsDb();
  const stmt = database.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total
    FROM step_runs
    WHERE started_at >= ? AND started_at <= ?
  `);
  const result = stmt.get(
    startDate.toISOString(),
    endDate.toISOString()
  ) as { total: number };
  return result.total;
}

/**
 * Gets cost for today
 */
export function getTodayCost(): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return getCostForPeriod(today, tomorrow);
}

/**
 * Gets cost for this week (starting Monday)
 */
export function getWeekCost(): number {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(monday.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  return getCostForPeriod(monday, nextMonday);
}

/**
 * Closes the database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Clears all metrics data (useful for testing)
 */
export function clearMetrics(): void {
  const database = getMetricsDb();
  database.exec(`
    DELETE FROM step_runs;
    DELETE FROM workflow_runs;
  `);
}
