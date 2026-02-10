import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { join } from "path";
import { execSync } from "child_process";
import {
  hasReviewFormat,
  copyReviewFormat,
  findClaudeReviewWorkflows,
  updateWorkflowReviewPrompt,
  CI_REVIEW_PROMPT,
} from "./review-setup.js";

// Only mock writeFileSync and mkdirSync — leave reads intact
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";

/** Write a temp file using child_process to bypass fs mock */
function writeTmpFile(path: string, content: string): void {
  execSync(`cat > '${path}'`, { input: content });
}

/** Remove a temp file */
function removeTmpFile(path: string): void {
  try { execSync(`rm -f '${path}'`); } catch { /* ignore */ }
}

describe("CI_REVIEW_PROMPT", () => {
  it("includes verdict instruction", () => {
    expect(CI_REVIEW_PROMPT).toContain("**Verdict:**");
    expect(CI_REVIEW_PROMPT).toContain("PASS");
    expect(CI_REVIEW_PROMPT).toContain("NEEDS_CHANGES");
  });

  it("references the format doc", () => {
    expect(CI_REVIEW_PROMPT).toContain("docs/llm/code-review-output-format.md");
  });

  it("mentions severity levels", () => {
    expect(CI_REVIEW_PROMPT).toContain("Critical");
    expect(CI_REVIEW_PROMPT).toContain("Major");
    expect(CI_REVIEW_PROMPT).toContain("Minor");
  });
});

describe("hasReviewFormat", () => {
  it("returns true when format doc exists", () => {
    const result = hasReviewFormat(process.cwd());
    expect(result).toBe(true);
  });

  it("returns false for a path without the doc", () => {
    const result = hasReviewFormat("/tmp/nonexistent-project");
    expect(result).toBe(false);
  });
});

describe("copyReviewFormat", () => {
  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(mkdirSync).mockClear();
  });

  it("copies the format doc to target project", () => {
    const targetPath = "/tmp/test-project";

    copyReviewFormat(targetPath);

    expect(mkdirSync).toHaveBeenCalledWith(
      join(targetPath, "docs", "llm"),
      { recursive: true }
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      join(targetPath, "docs", "llm", "code-review-output-format.md"),
      expect.stringContaining("# Code Review Output Format")
    );
  });
});

describe("findClaudeReviewWorkflows", () => {
  it("returns empty array when no .github/workflows dir", () => {
    const result = findClaudeReviewWorkflows("/tmp/nonexistent");
    expect(result).toEqual([]);
  });

  it("finds workflows in bridget_ai", () => {
    const bridgetPath = join(process.env.HOME || "", "work", "bridget_ai");
    if (!existsSync(bridgetPath)) return;

    const workflows = findClaudeReviewWorkflows(bridgetPath);
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows[0].filename).toBe("ci.yml");
  });
});

describe("updateWorkflowReviewPrompt", () => {
  const tmpPath = "/tmp/whs-test-ci-workflow.yml";

  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
  });

  afterAll(() => {
    removeTmpFile(tmpPath);
  });

  it("returns not found for missing file", () => {
    const result = updateWorkflowReviewPrompt("/tmp/nonexistent-whs-test.yml");
    expect(result.updated).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("reports already-updated workflows", () => {
    writeTmpFile(
      tmpPath,
      "uses: anthropics/claude-code-action@v1\nprompt: |\n  docs/llm/code-review-output-format.md\n"
    );

    const result = updateWorkflowReviewPrompt(tmpPath);
    expect(result.updated).toBe(false);
    expect(result.reason).toContain("Already references");
  });

  it("updates prompt in a workflow file", () => {
    const workflowContent = [
      "name: CI",
      "",
      "on:",
      "  pull_request:",
      "    branches: [main]",
      "",
      "jobs:",
      "  claude-review:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
      "      - name: Run Claude Code Review",
      "        uses: anthropics/claude-code-action@v1",
      "        with:",
      "          claude_code_oauth_token: ${{ secrets.TOKEN }}",
      "          prompt: |",
      "            Please review this pull request.",
      "            Be constructive and helpful.",
      "          claude_args: '--allowed-tools \"Read,Glob\"'",
    ].join("\n");

    writeTmpFile(tmpPath, workflowContent);

    const result = updateWorkflowReviewPrompt(tmpPath);

    expect(result.updated).toBe(true);
    expect(writeFileSync).toHaveBeenCalledTimes(1);

    const writtenContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(writtenContent).toContain("code-review-output-format.md");
    expect(writtenContent).toContain("**Verdict:**");
    expect(writtenContent).toContain("claude-review:");
    expect(writtenContent).toContain("claude_args:");
    expect(writtenContent).not.toContain("Be constructive and helpful");
  });

  it("updates prompt in bridget_ai CI workflow", () => {
    const bridgetPath = join(process.env.HOME || "", "work", "bridget_ai");
    if (!existsSync(bridgetPath)) return;

    const workflowPath = join(bridgetPath, ".github", "workflows", "ci.yml");
    if (!existsSync(workflowPath)) return;

    const content = readFileSync(workflowPath, "utf-8");
    if (content.includes("code-review-output-format.md")) return;

    const result = updateWorkflowReviewPrompt(workflowPath);
    expect(result.updated).toBe(true);

    const writtenContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(writtenContent).toContain("code-review-output-format.md");
    expect(writtenContent).toContain("**Verdict:**");
    expect(writtenContent).toContain("claude-review:");
    expect(writtenContent).toContain("claude_args:");
  });
});
