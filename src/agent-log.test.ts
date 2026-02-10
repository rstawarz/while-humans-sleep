import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  logAgentEvent,
  readAgentLog,
  cleanAllLogs,
  getLogsDir,
  getAgentLogPath,
} from "./agent-log.js";

// Use a unique temp directory per test run to avoid races between src and dist
let TEST_DIR: string;
let LOGS_DIR: string;

vi.mock("./config.js", () => ({
  getConfigDir: () => TEST_DIR,
}));

describe("agent-log", () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), "agent-log-test-"));
    LOGS_DIR = join(TEST_DIR, "logs");
    mkdirSync(LOGS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("getLogsDir", () => {
    it("returns the logs directory path", () => {
      expect(getLogsDir()).toBe(LOGS_DIR);
    });

    it("creates the directory if it doesn't exist", () => {
      rmSync(LOGS_DIR, { recursive: true, force: true });
      expect(existsSync(LOGS_DIR)).toBe(false);
      getLogsDir();
      expect(existsSync(LOGS_DIR)).toBe(true);
    });
  });

  describe("getAgentLogPath", () => {
    it("returns the log file path for a step", () => {
      expect(getAgentLogPath("orc-abc.1")).toBe(join(LOGS_DIR, "orc-abc.1.jsonl"));
    });
  });

  describe("logAgentEvent", () => {
    it("writes a JSONL entry to the log file", () => {
      logAgentEvent("step-1", { type: "start", agent: "implementation" });

      const events = readAgentLog("step-1");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("start");
      expect(events[0].agent).toBe("implementation");
      expect(events[0].t).toBeTypeOf("number");
    });

    it("appends multiple entries", () => {
      logAgentEvent("step-1", { type: "start", agent: "impl" });
      logAgentEvent("step-1", { type: "tool", name: "Bash", input: "npm test" });
      logAgentEvent("step-1", { type: "end", outcome: "quality_review", cost: 0.05 });

      const events = readAgentLog("step-1");
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("start");
      expect(events[1].type).toBe("tool");
      expect(events[1].name).toBe("Bash");
      expect(events[2].type).toBe("end");
      expect(events[2].cost).toBe(0.05);
    });

    it("truncates long text fields", () => {
      const longText = "x".repeat(500);
      logAgentEvent("step-1", { type: "text", text: longText });

      const events = readAgentLog("step-1");
      expect(events[0].text!.length).toBe(203); // 200 + "..."
      expect(events[0].text!.endsWith("...")).toBe(true);
    });

    it("truncates long input fields", () => {
      const longInput = "y".repeat(500);
      logAgentEvent("step-1", { type: "tool", name: "Read", input: longInput });

      const events = readAgentLog("step-1");
      expect(events[0].input!.length).toBe(203);
      expect(events[0].input!.endsWith("...")).toBe(true);
    });

    it("does not truncate short fields", () => {
      logAgentEvent("step-1", { type: "text", text: "hello" });

      const events = readAgentLog("step-1");
      expect(events[0].text).toBe("hello");
    });

    it("writes to separate files per step", () => {
      logAgentEvent("step-a", { type: "start", agent: "a" });
      logAgentEvent("step-b", { type: "start", agent: "b" });

      expect(readAgentLog("step-a")).toHaveLength(1);
      expect(readAgentLog("step-b")).toHaveLength(1);
      expect(readAgentLog("step-a")[0].agent).toBe("a");
      expect(readAgentLog("step-b")[0].agent).toBe("b");
    });
  });

  describe("readAgentLog", () => {
    it("returns empty array for nonexistent step", () => {
      expect(readAgentLog("nonexistent")).toEqual([]);
    });

    it("returns empty array for empty file", () => {
      writeFileSync(join(LOGS_DIR, "empty.jsonl"), "");
      expect(readAgentLog("empty")).toEqual([]);
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        logAgentEvent("step-1", { type: "text", text: `msg ${i}` });
      }

      const last3 = readAgentLog("step-1", 3);
      expect(last3).toHaveLength(3);
      expect(last3[0].text).toBe("msg 7");
      expect(last3[2].text).toBe("msg 9");
    });

    it("returns all entries when fewer than limit", () => {
      logAgentEvent("step-1", { type: "start", agent: "impl" });
      logAgentEvent("step-1", { type: "end", outcome: "DONE" });

      const events = readAgentLog("step-1", 20);
      expect(events).toHaveLength(2);
    });
  });

  describe("cleanAllLogs", () => {
    it("deletes all .jsonl files in logs directory", () => {
      logAgentEvent("step-a", { type: "start", agent: "a" });
      logAgentEvent("step-b", { type: "start", agent: "b" });

      expect(readdirSync(LOGS_DIR).filter((f) => f.endsWith(".jsonl"))).toHaveLength(2);

      cleanAllLogs();

      expect(readdirSync(LOGS_DIR).filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);
    });

    it("does not delete non-.jsonl files", () => {
      writeFileSync(join(LOGS_DIR, "keep-me.txt"), "important");
      logAgentEvent("step-1", { type: "start", agent: "impl" });

      cleanAllLogs();

      const remaining = readdirSync(LOGS_DIR);
      expect(remaining).toContain("keep-me.txt");
      expect(remaining.filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);
    });

    it("succeeds when logs directory is empty", () => {
      expect(() => cleanAllLogs()).not.toThrow();
    });
  });
});
