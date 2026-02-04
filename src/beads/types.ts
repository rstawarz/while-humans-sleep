/**
 * Types for Beads CLI responses
 */

export interface Bead {
  id: string;
  title: string;
  description: string;
  type: "epic" | "task" | "bug" | "feature" | "chore" | "question";
  status: "open" | "in_progress" | "blocked" | "deferred" | "closed" | "tombstone" | "pinned";
  priority: number; // 0-4, where 0 is critical
  labels: string[];
  parent?: string;
  dependencies: string[];
  created_at: string;
  updated_at: string;
}

export interface BeadCreateOptions {
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
}
