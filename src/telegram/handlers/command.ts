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
    const lockInfo = getLockInfo();
    if (!lockInfo) {
      await ctx.reply("Dispatcher is *not running*\\.", { parse_mode: "MarkdownV2" });
      return true;
    }

    const state = loadState();
    const statusText = state.paused ? "PAUSED" : "Running";
    const activeCount = state.activeWork.size;

    const lines: string[] = [];
    lines.push(`*Dispatcher Status*`);
    lines.push(`Status: *${escapeMarkdownV2(statusText)}*`);
    lines.push(`PID: \`${lockInfo.pid}\``);
    lines.push(`Active work: ${activeCount}`);

    if (activeCount > 0) {
      const projects = new Set<string>();
      for (const work of state.activeWork.values()) {
        projects.add(work.workItem.project);
      }
      lines.push(`Projects: ${escapeMarkdownV2([...projects].join(", "))}`);
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
    return true;
  }
}
