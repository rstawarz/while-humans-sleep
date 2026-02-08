/**
 * Command Handler - Handles /pause, /resume, /status commands via Telegram
 *
 * Sends SIGUSR1/SIGUSR2 signals to the dispatcher process,
 * matching the same approach used by the CLI commands.
 */

import type { Context } from "grammy";
import type { TelegramHandler } from "./types.js";
import { getLockInfo, loadState } from "../../state.js";
import { escapeMarkdownV2 } from "../formatter.js";
import { VERSION } from "../../version.js";
import { loadConfig, expandPath } from "../../config.js";
import { beads } from "../../beads/index.js";
import { getErroredWorkflows } from "../../workflow.js";
import { getTodayCost, getWorkflowSteps } from "../../metrics.js";

const COMMANDS = ["/pause", "/resume", "/status"];

/**
 * Format a duration in milliseconds as a human-readable string
 *
 * Returns "Xh Ym", "Ym", or "<1m"
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);

  if (totalMinutes < 1) return "<1m";

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/**
 * Handler for dispatcher control commands via Telegram
 */
export class CommandHandler implements TelegramHandler {
  readonly name = "command";

  canHandle(ctx: Context): boolean {
    const text = ctx.message?.text?.trim();
    if (!text) return false;
    return COMMANDS.some((cmd) => text === cmd || text.startsWith(cmd + " "));
  }

  async handle(ctx: Context): Promise<boolean> {
    const text = ctx.message?.text?.trim();
    if (!text) return false;

    if (text.startsWith("/pause")) {
      return this.handlePause(ctx);
    }
    if (text.startsWith("/resume")) {
      return this.handleResume(ctx);
    }
    if (text.startsWith("/status")) {
      return this.handleStatus(ctx);
    }

    return false;
  }

  private async handlePause(ctx: Context): Promise<boolean> {
    const lockInfo = getLockInfo();
    if (!lockInfo) {
      await ctx.reply("No dispatcher is running\\.", { parse_mode: "MarkdownV2" });
      return true;
    }

    const state = loadState();
    if (state.paused) {
      await ctx.reply("Dispatcher is already paused\\.", { parse_mode: "MarkdownV2" });
      return true;
    }

    try {
      process.kill(lockInfo.pid, "SIGUSR1");
      await ctx.reply(
        "\\u23F8\\uFE0F Dispatcher *paused*\\.\nRunning agents will finish, no new work picked up\\.\nSend /resume to continue\\.",
        { parse_mode: "MarkdownV2" }
      );
    } catch (err) {
      await ctx.reply(
        `Failed to pause: ${escapeMarkdownV2(err instanceof Error ? err.message : String(err))}`,
        { parse_mode: "MarkdownV2" }
      );
    }

    return true;
  }

  private async handleResume(ctx: Context): Promise<boolean> {
    const lockInfo = getLockInfo();
    if (!lockInfo) {
      await ctx.reply("No dispatcher is running\\.", { parse_mode: "MarkdownV2" });
      return true;
    }

    const state = loadState();
    if (!state.paused) {
      await ctx.reply("Dispatcher is not paused\\.", { parse_mode: "MarkdownV2" });
      return true;
    }

    try {
      process.kill(lockInfo.pid, "SIGUSR2");
      await ctx.reply("\\u25B6\\uFE0F Dispatcher *resumed*\\.", { parse_mode: "MarkdownV2" });
    } catch (err) {
      await ctx.reply(
        `Failed to resume: ${escapeMarkdownV2(err instanceof Error ? err.message : String(err))}`,
        { parse_mode: "MarkdownV2" }
      );
    }

    return true;
  }

  private async handleStatus(ctx: Context): Promise<boolean> {
    const lockInfo = getLockInfo();
    const lines: string[] = [];

    // Header
    lines.push(`*WHS v${escapeMarkdownV2(VERSION)}*`);
    lines.push("");

    // Stopped state — minimal output
    if (!lockInfo) {
      lines.push(`Status: *Stopped*`);
      lines.push("");
      try {
        const cost = getTodayCost();
        lines.push(`Today: ${escapeMarkdownV2("$" + cost.toFixed(2))}`);
      } catch {
        lines.push(`Today: ${escapeMarkdownV2("$0.00")}`);
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
      return true;
    }

    // Running/Paused state
    const state = loadState();
    const statusText = state.paused ? "PAUSED" : "Running";
    const uptime = formatDuration(Date.now() - new Date(lockInfo.startedAt).getTime());

    lines.push(`Status: *${escapeMarkdownV2(statusText)}* \\(PID ${lockInfo.pid}\\)`);
    lines.push(`Uptime: ${escapeMarkdownV2(uptime)}`);

    // Active work section
    const activeCount = state.activeWork.size;
    lines.push("");
    lines.push(`*Active Work* \\(${activeCount}\\)`);

    if (activeCount > 0) {
      for (const work of state.activeWork.values()) {
        const title = work.workItem.title || work.workItem.id;
        const source = `${work.workItem.project}/${work.workItem.id}`;
        const duration = formatDuration(Date.now() - new Date(work.startedAt).getTime());
        const cost = "$" + (work.costSoFar || 0).toFixed(2);

        // Determine step number from metrics
        let stepInfo = work.agent;
        try {
          const steps = getWorkflowSteps(work.workflowEpicId);
          // steps includes completed + current; count completed + 1 for current
          const completedSteps = steps.filter((s) => s.completed_at !== null).length;
          const stepNum = completedSteps + 1;
          stepInfo = `${work.agent} \\(step ${stepNum}\\)`;
        } catch {
          stepInfo = escapeMarkdownV2(work.agent);
        }

        lines.push(`  ${escapeMarkdownV2(title)}`);
        lines.push(`  ${escapeMarkdownV2(source)}`);
        lines.push(`  ${stepInfo} \\| ${escapeMarkdownV2(duration)} \\| ${escapeMarkdownV2(cost)}`);
        lines.push("");
      }
    }

    // Questions
    let questionCount = 0;
    try {
      const config = loadConfig();
      const orchestratorPath = expandPath(config.orchestratorPath);
      const pendingQuestions = beads.listPendingQuestions(orchestratorPath);
      questionCount = pendingQuestions.length;

      if (questionCount > 0) {
        lines.push(`*Questions* \\(${questionCount}\\)`);
        for (const q of pendingQuestions.slice(0, 3)) {
          try {
            const data = beads.parseQuestionData(q);
            const firstQuestion = data.questions?.[0]?.question || q.title;
            const project = data.metadata?.project || "";
            const suffix = project ? ` \\(${escapeMarkdownV2(project)}\\)` : "";
            lines.push(`  ${escapeMarkdownV2(firstQuestion)}${suffix}`);
          } catch {
            lines.push(`  ${escapeMarkdownV2(q.title)}`);
          }
        }
        lines.push("");
      } else {
        lines.push(`Questions: 0`);
      }
    } catch {
      lines.push(`Questions: 0`);
    }

    // Errored workflows
    try {
      const errored = getErroredWorkflows();
      if (errored.length > 0) {
        lines.push(`*Errored* \\(${errored.length}\\)`);
        for (const e of errored.slice(0, 3)) {
          lines.push(`  ${escapeMarkdownV2(`${e.sourceProject}/${e.sourceBeadId}`)} \\(${escapeMarkdownV2(e.errorType)}\\)`);
        }
        lines.push("");
      } else {
        lines.push(`Errored: 0`);
      }
    } catch {
      lines.push(`Errored: 0`);
    }

    // Today's cost
    try {
      const cost = getTodayCost();
      lines.push(`Today: ${escapeMarkdownV2("$" + cost.toFixed(2))}`);
    } catch {
      lines.push(`Today: ${escapeMarkdownV2("$0.00")}`);
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
    return true;
  }
}
