/**
 * TUI Logger — captures log output for the ink dashboard.
 *
 * Instead of writing to stdout, entries are pushed into a list
 * that the Dashboard component renders via ink's <Static>.
 */

import type { Logger } from "../logger.js";

export interface LogEntry {
  id: number;
  text: string;
  level: "log" | "warn" | "error";
  timestamp: Date;
}

export class TUILogger implements Logger {
  private entries: LogEntry[] = [];
  private nextId = 0;
  private onChange?: () => void;

  log(message: string): void {
    this.push({ level: "log", text: message });
  }

  warn(message: string): void {
    this.push({ level: "warn", text: message });
  }

  error(message: string): void {
    this.push({ level: "error", text: message });
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  subscribe(fn: () => void): void {
    this.onChange = fn;
  }

  private push(entry: Omit<LogEntry, "id" | "timestamp">): void {
    this.entries.push({ ...entry, id: this.nextId++, timestamp: new Date() });
    this.onChange?.();
  }
}
