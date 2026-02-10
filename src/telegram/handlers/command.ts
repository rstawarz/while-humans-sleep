/**
 * Command Handler - Handles /pause, /resume, /status commands via Telegram
 *
 * Sends SIGUSR1/SIGUSR2 signals to the dispatcher process,
 * matching the same approach used by the CLI commands.
 */

import type { Context } from "grammy";
import type { TelegramHandler } from "./types.js";
import type { AgentLogEvent } from "../../agent-log.js";
import { getLockInfo, loadState } from "../../state.js";
import { escapeMarkdownV2 } from "../formatter.js";
import { getStatusData, getStepDetail, formatDuration } from "../../status.js";

// Re-export formatDuration for backwards compatibility with tests
export { formatDuration } from "../../status.js";

const COMMANDS = ["/pause", "/resume", "/status"];

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
    // Check for step argument: "/status orc-yq0.2" or "/status bridget_ai/orc-yq0.2"
    const text = ctx.message?.text?.trim() || "";
    const stepArg = text.replace(/^\/status\s*/, "").trim();
    if (stepArg) {
      return this.handleStepDetail(ctx, stepArg);
    }

    const status = getStatusData();
    const lines: string[] = [];

    // Header
    lines.push(`*WHS v${escapeMarkdownV2(status.version)}*`);
    lines.push("");

    // Stopped state — minimal output
    if (!status.running) {
      lines.push(`Status: *Stopped*`);
      lines.push("");
      lines.push(`Today: ${escapeMarkdownV2("$" + status.todayCost.toFixed(2))}`);
      await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
      return true;
    }

    // Running/Paused state
    const statusText = status.paused ? "PAUSED" : "Running";
    const uptime = formatDuration(status.uptimeMs);

    lines.push(`Status: *${escapeMarkdownV2(statusText)}* \\(PID ${status.pid}\\)`);
    lines.push(`Uptime: ${escapeMarkdownV2(uptime)}`);

    // Active work section
    lines.push("");
    lines.push(`*Active Work* \\(${status.activeWork.length}\\)`);

    for (const work of status.activeWork) {
      const duration = formatDuration(work.durationMs);
      const cost = "$" + work.cost.toFixed(2);
      const stepInfo = `${escapeMarkdownV2(work.agent)} \\(step ${work.stepNumber}\\)`;

      lines.push(`  ${escapeMarkdownV2(work.title)}`);
      lines.push(`  ${escapeMarkdownV2(work.source)}`);

      let detailLine = `  ${stepInfo} \\| ${escapeMarkdownV2(duration)} \\| ${escapeMarkdownV2(cost)}`;
      if (work.prUrl) {
        detailLine += ` \\| [PR \\#${work.prNumber}](${escapeMarkdownV2(work.prUrl)})`;
      }
      lines.push(detailLine);
      lines.push("");
    }

    // Questions
    if (status.questions.length > 0) {
      lines.push(`*Questions* \\(${status.questions.length}\\)`);
      for (const q of status.questions.slice(0, 3)) {
        const suffix = q.project ? ` \\(${escapeMarkdownV2(q.project)}\\)` : "";
        lines.push(`  ${escapeMarkdownV2(q.question)}${suffix}`);
      }
      lines.push("");
    } else {
      lines.push(`Questions: 0`);
    }

    // Errored workflows
    if (status.errored.length > 0) {
      lines.push(`*Errored* \\(${status.errored.length}\\)`);
      for (const e of status.errored.slice(0, 3)) {
        lines.push(`  ${escapeMarkdownV2(e.source)} \\(${escapeMarkdownV2(e.errorType)}\\)`);
      }
      lines.push("");
    } else {
      lines.push(`Errored: 0`);
    }

    // Today's cost
    lines.push(`Today: ${escapeMarkdownV2("$" + status.todayCost.toFixed(2))}`);

    await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
    return true;
  }

  private async handleStepDetail(ctx: Context, stepQuery: string): Promise<boolean> {
    const detail = getStepDetail(stepQuery);
    if (!detail) {
      await ctx.reply(
        `No workflow found matching "${escapeMarkdownV2(stepQuery)}"\\.\nUse /status to see all active work\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return true;
    }

    const { work, recentActivity } = detail;
    const duration = formatDuration(work.durationMs);
    const lines: string[] = [];

    lines.push(`*${escapeMarkdownV2(work.title)}*`);
    lines.push(`${escapeMarkdownV2(work.source)} \\| ${escapeMarkdownV2(work.agent)} \\(step ${work.stepNumber}\\)`);
    lines.push(`${escapeMarkdownV2(duration)} \\| ${escapeMarkdownV2("$" + work.cost.toFixed(4))}`);

    if (work.prUrl) {
      lines.push(`[PR \\#${work.prNumber}](${escapeMarkdownV2(work.prUrl)})`);
    }

    // Show workflow status for bead-based lookups
    if (detail.workflowStatus) {
      lines.push(`Workflow: *${escapeMarkdownV2(detail.workflowStatus)}*`);
    }

    lines.push("");

    // Show step history for bead-based lookups
    if (detail.workflowSteps && detail.workflowSteps.length > 0) {
      lines.push("*Step History*");
      for (const s of detail.workflowSteps) {
        const sDuration = formatDuration(s.durationMs);
        const outcome = s.outcome || "in progress";
        const sCost = s.cost > 0 ? ` \\| ${escapeMarkdownV2("$" + s.cost.toFixed(4))}` : "";
        lines.push(
          `${escapeMarkdownV2(s.agent)} → ${escapeMarkdownV2(outcome)} \\(${escapeMarkdownV2(sDuration)}${sCost}\\)`
        );
      }
      lines.push("");
    } else if (recentActivity.length === 0) {
      lines.push("_No activity logged yet\\._");
    }

    // Show recent activity (only for live/active steps)
    if (recentActivity.length > 0) {
      lines.push("*Recent Activity*");
      const now = Math.floor(Date.now() / 1000);
      // Show last 10 events to keep message manageable for Telegram
      const events = recentActivity.slice(-10);
      for (const event of events) {
        const ago = formatSecondsAgo(now - event.t);
        lines.push(escapeMarkdownV2(formatLogEventPlain(event, ago)));
      }
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
    return true;
  }
}

/** Format seconds as a human-readable "Xm ago" / "Xh ago" / "Xs ago" string */
function formatSecondsAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
}

/** Format an agent log event as a single plain-text line */
function formatLogEventPlain(event: AgentLogEvent, ago: string): string {
  switch (event.type) {
    case "start":
      return `[${ago}] > Started ${event.agent || "agent"}`;
    case "tool":
      return `[${ago}] @ ${event.name || "tool"}${event.input ? ": " + event.input : ""}`;
    case "text":
      return `[${ago}] ${event.text || ""}`;
    case "end":
      return `[${ago}] Done -> ${event.outcome || "unknown"}${event.cost != null ? ` ($${event.cost.toFixed(4)})` : ""}`;
    default:
      return `[${ago}] ${event.type}`;
  }
}
