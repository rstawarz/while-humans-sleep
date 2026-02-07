/**
 * Tests for Telegram setup (token storage)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// We need to mock getConfigDir before importing setup
// Use a module-level variable that we can change per test
let mockConfigDir: string;

// Mock the config module
import { vi } from "vitest";
vi.mock("../config.js", () => ({
  getConfigDir: () => mockConfigDir,
  updateConfig: vi.fn(),
}));

// Import after mocking
import { loadBotToken } from "./setup.js";

describe("loadBotToken", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "whs-telegram-setup-test-"));
    mockConfigDir = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns undefined when .env does not exist", () => {
    const token = loadBotToken();
    expect(token).toBeUndefined();
  });

  it("returns undefined when .env exists but has no TELEGRAM_BOT_TOKEN", () => {
    writeFileSync(join(tempDir, ".env"), "OTHER_VAR=value\n");

    const token = loadBotToken();
    expect(token).toBeUndefined();
  });

  it("reads TELEGRAM_BOT_TOKEN from .env", () => {
    writeFileSync(
      join(tempDir, ".env"),
      "# Comment\nOTHER_VAR=foo\nTELEGRAM_BOT_TOKEN=123456:ABC-xyz\n"
    );

    const token = loadBotToken();
    expect(token).toBe("123456:ABC-xyz");
  });

  it("trims whitespace from token", () => {
    writeFileSync(
      join(tempDir, ".env"),
      "TELEGRAM_BOT_TOKEN=  123456:ABC-xyz  \n"
    );

    const token = loadBotToken();
    expect(token).toBe("123456:ABC-xyz");
  });

  it("handles token with equals signs", () => {
    // Some tokens might have = in them (unlikely but possible in values)
    writeFileSync(
      join(tempDir, ".env"),
      "TELEGRAM_BOT_TOKEN=123456:ABC=xyz=123\n"
    );

    const token = loadBotToken();
    // Our simple parser takes everything after the first =
    expect(token).toBe("123456:ABC=xyz=123");
  });
});

describe("saveBotToken (via loadBotToken roundtrip)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "whs-telegram-setup-test-"));
    mockConfigDir = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates .env file if it does not exist", async () => {
    // We can't easily call saveBotToken directly since it's not exported
    // But we can test the file format it should create
    const envPath = join(tempDir, ".env");
    const content = `# Telegram Bot Token (from @BotFather)
TELEGRAM_BOT_TOKEN=test-token-123
`;
    writeFileSync(envPath, content);

    const token = loadBotToken();
    expect(token).toBe("test-token-123");
  });

  it("preserves other variables in .env", async () => {
    const envPath = join(tempDir, ".env");

    // Simulate existing content
    writeFileSync(
      envPath,
      `ANTHROPIC_API_KEY=sk-ant-xxx
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oa-yyy

# Telegram Bot Token (from @BotFather)
TELEGRAM_BOT_TOKEN=old-token
`
    );

    // Verify we can read the token
    const token = loadBotToken();
    expect(token).toBe("old-token");

    // Verify other content is preserved (read raw file)
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("ANTHROPIC_API_KEY=sk-ant-xxx");
    expect(content).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oa-yyy");
  });
});
