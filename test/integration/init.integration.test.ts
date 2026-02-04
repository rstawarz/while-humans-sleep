/**
 * Integration tests for whs init command
 *
 * Tests that WHS initialization creates the proper directory structure
 * and config files in the current directory.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import {
  initializeWhs,
  loadConfig,
  isInitialized,
  isInitializedInDir,
  findConfigDir,
} from "../../src/config.js";

const FIXTURES_BASE = resolve(__dirname, "fixtures");
// Use /tmp for tests that need to be outside any WHS hierarchy
const TMP_FIXTURES_BASE = "/tmp/whs-test-fixtures";

// Helper to create a unique test directory
function createTestDir(testName: string, useTmp: boolean = false): string {
  const timestamp = Date.now();
  const pid = process.pid;
  const dirName = `${testName}-${pid}-${timestamp}`;
  const base = useTmp ? TMP_FIXTURES_BASE : FIXTURES_BASE;
  const path = join(base, dirName);
  mkdirSync(path, { recursive: true });
  return path;
}

// Helper to cleanup test directories
function cleanupTestDir(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

describe("whs init", () => {
  const testDirs: string[] = [];

  afterEach(() => {
    // Clean up all test directories
    for (const dir of testDirs) {
      cleanupTestDir(dir);
    }
    testDirs.length = 0;
  });

  it("creates .whs/ directory in current directory", () => {
    const testDir = createTestDir("init-creates-whs");
    testDirs.push(testDir);

    // Initialize WHS
    initializeWhs(testDir);

    // Check .whs/ exists
    expect(existsSync(join(testDir, ".whs"))).toBe(true);
    expect(existsSync(join(testDir, ".whs", "config.json"))).toBe(true);
  });

  it("creates config with orchestratorPath set to current directory", () => {
    const testDir = createTestDir("init-orchestrator-path");
    testDirs.push(testDir);

    initializeWhs(testDir);
    const config = loadConfig(testDir);

    expect(config.orchestratorPath).toBe(testDir);
  });

  it("creates config with default values", () => {
    const testDir = createTestDir("init-default-config");
    testDirs.push(testDir);

    initializeWhs(testDir);
    const config = loadConfig(testDir);

    expect(config.projects).toEqual([]);
    expect(config.concurrency.maxTotal).toBe(4);
    expect(config.concurrency.maxPerProject).toBe(2);
    expect(config.notifier).toBe("cli");
  });

  it("throws error if already initialized in directory", () => {
    const testDir = createTestDir("init-already-exists");
    testDirs.push(testDir);

    // First init
    initializeWhs(testDir);

    // Second init should throw
    expect(() => initializeWhs(testDir)).toThrow("already initialized");
  });

  it("isInitialized returns true after init", () => {
    // Use /tmp to be outside any existing WHS hierarchy (like ~/.whs)
    const testDir = createTestDir("init-check-initialized", true);
    testDirs.push(testDir);

    expect(isInitialized(testDir)).toBe(false);
    initializeWhs(testDir);
    expect(isInitialized(testDir)).toBe(true);
  });

  it("isInitializedInDir checks only the specific directory", () => {
    const testDir = createTestDir("init-check-specific");
    testDirs.push(testDir);

    const subDir = join(testDir, "subdir");
    mkdirSync(subDir, { recursive: true });

    // Init in parent
    initializeWhs(testDir);

    // isInitializedInDir should only return true for the exact directory
    expect(isInitializedInDir(testDir)).toBe(true);
    expect(isInitializedInDir(subDir)).toBe(false);

    // But isInitialized walks up and finds parent
    expect(isInitialized(subDir)).toBe(true);
  });

  it("findConfigDir walks up directory tree", () => {
    const testDir = createTestDir("init-find-walks-up");
    testDirs.push(testDir);

    const subDir = join(testDir, "a", "b", "c");
    mkdirSync(subDir, { recursive: true });

    // Init in root
    initializeWhs(testDir);

    // findConfigDir from subdirectory should find parent
    const found = findConfigDir(subDir);
    expect(found).toBe(join(testDir, ".whs"));
  });

  it("findConfigDir returns null when not in orchestrator", () => {
    // Use /tmp to be outside any existing WHS hierarchy (like ~/.whs)
    const testDir = createTestDir("init-not-found", true);
    testDirs.push(testDir);

    // Don't initialize WHS
    const found = findConfigDir(testDir);
    expect(found).toBeNull();
  });
});
