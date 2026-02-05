/**
 * Types for Beads CLI responses
 */

/**
 * Raw bead data as returned by beads CLI
 * Note: CLI uses `issue_type` not `type`
 */
export interface RawBead {
  id: string;
  title: string;
  description?: string;
  issue_type: string;
  status: string;
  priority: number;
  labels?: string[];
  parent?: string;
  dependencies?: string[];
  created_at: string;
  updated_at: string;
}

/**
 * Normalized bead data used by WHS
 */
export interface Bead {
  id: string;
  title: string;
  description: string;
  // Valid beads types - note: "question" is not a valid bd type, we use "task" with label "whs:question"
  type: "epic" | "task" | "bug" | "feature" | "chore" | "merge-request" | "molecule" | "gate" | "agent" | "role" | "rig" | "convoy" | "event";
  status: "open" | "in_progress" | "blocked" | "deferred" | "closed" | "tombstone" | "pinned";
  priority: number; // 0-4, where 0 is critical
  labels: string[];
  parent?: string;
  dependencies: string[];
  created_at: string;
  updated_at: string;
}

/**
 * Normalizes raw beads CLI output to our Bead interface
 */
export function normalizeBead(raw: RawBead): Bead {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description || "",
    type: raw.issue_type as Bead["type"],
    status: raw.status as Bead["status"],
    priority: raw.priority,
    labels: raw.labels || [],
    parent: raw.parent,
    dependencies: raw.dependencies || [],
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

export interface BeadCreateOptions {
  /** Issue type - use valid bd types only */
  type?: Bead["type"];
  priority?: number;
  description?: string;
  parent?: string;
  status?: Bead["status"];
  labels?: string[];
}

export interface BeadUpdateOptions {
  title?: string;
  description?: string;
  priority?: number;
  status?: Bead["status"];
  labelAdd?: string[];
  labelRemove?: string[];
}

export interface BeadListOptions {
  status?: Bead["status"];
  type?: Bead["type"];
  parent?: string;
  priority?: number;
  priorityMin?: number;
  priorityMax?: number;
  labelAny?: string[];
  labelAll?: string[];
  labelNone?: string[];
  sort?: "priority" | "created" | "updated" | "closed" | "status" | "id" | "title" | "type";
  reverse?: boolean;
}
