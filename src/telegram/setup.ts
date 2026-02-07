/**
 * Telegram Setup Wizard
 *
 * Interactive setup for configuring Telegram bot integration.
 * Guides user through:
 * 1. Creating a bot with @BotFather
 * 2. Getting the bot token
 * 3. Getting their chat ID
 * 4. Validating the configuration
 *
 * Security: Bot token is stored in .whs/.env (gitignored), not config.json
 */

import { Bot } from "grammy";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { updateConfig, getConfigDir } from "../config.js";

/**
 * Save the Telegram bot token to .whs/.env
 */
function saveBotToken(botToken: string): void {
  const configDir = getConfigDir();
  const envPath = join(configDir, ".env");

  // Read existing .env if it exists, preserve other vars
  let existingContent = "";
  try {
    existingContent = readFileSync(envPath, "utf-8");
  } catch {
    // File doesn't exist, that's fine
  }

  // Remove any existing TELEGRAM_BOT_TOKEN line
  const filteredLines = existingContent
    .split("\n")
    .filter((line) => !line.startsWith("TELEGRAM_BOT_TOKEN="));

  // Add new token
  const newContent = [
    ...filteredLines.filter((l) => l.trim()),
    "",
    "# Telegram Bot Token (from @BotFather)",
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    "",
  ].join("\n");

  writeFileSync(envPath, newContent);
}

/**
 * Load Telegram bot token from .whs/.env
 */
export function loadBotToken(): string | undefined {
  try {
    const configDir = getConfigDir();
    const envPath = join(configDir, ".env");

    if (!existsSync(envPath)) return undefined;

    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("TELEGRAM_BOT_TOKEN=")) {
        return line.slice("TELEGRAM_BOT_TOKEN=".length).trim();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate Telegram configuration by making a test API call
 */
export async function validateTelegramConfig(
  botToken: string,
  chatId: string
): Promise<boolean> {
  try {
    const bot = new Bot(botToken);

    // Try to get bot info (validates token)
    const me = await bot.api.getMe();
    console.log(`    Bot: @${me.username}`);

    // Try to send a test message (validates chat ID and permissions)
    await bot.api.sendMessage(
      chatId,
      "\\u2705 WHS Telegram integration configured successfully\\!\n\nYou will receive questions and notifications here\\.",
      { parse_mode: "MarkdownV2" }
    );

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`    Error: ${message}`);
    return false;
  }
}

/**
 * Run the interactive setup wizard
 */
export async function runSetupWizard(
  ask: (prompt: string) => Promise<string>
): Promise<boolean> {
  console.log("\n  Telegram Setup\n");
  console.log("  Step 1: Create a bot");
  console.log("    1. Open Telegram and message @BotFather");
  console.log("    2. Send /newbot and follow the prompts");
  console.log("    3. Copy the bot token (looks like 123456789:ABC-xyz...)");
  console.log("");

  const botToken = await ask("  Paste your bot token: ");

  if (!botToken || !botToken.includes(":")) {
    console.log("\n    Invalid bot token format.");
    console.log("    Token should look like: 123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11");
    return false;
  }

  console.log("\n  Step 2: Get your chat ID");
  console.log("    1. Message your new bot (send any message)");
  console.log("    2. Visit: https://api.telegram.org/bot<TOKEN>/getUpdates");
  console.log("       (Replace <TOKEN> with your actual token)");
  console.log("    3. Find 'chat':{'id': YOUR_CHAT_ID} in the response");
  console.log("");
  console.log("    Tip: You can also use @userinfobot to get your chat ID");
  console.log("");

  const chatId = await ask("  Paste your chat ID: ");

  if (!chatId) {
    console.log("\n    Chat ID is required.");
    return false;
  }

  // Validate configuration
  console.log("\n  Validating configuration...");

  const valid = await validateTelegramConfig(botToken, chatId);
  if (!valid) {
    console.log("\n    Could not connect to Telegram.");
    console.log("    Please check your token and chat ID.");
    console.log("    Make sure you've messaged the bot at least once.");
    return false;
  }

  // Save token to .env (sensitive) and chatId to config.json (not sensitive)
  saveBotToken(botToken);
  updateConfig({
    telegram: { chatId },
    notifier: "telegram",
  });

  console.log("\n  Bot token saved to .whs/.env (keep this secret!)");
  console.log("  Chat ID saved to .whs/config.json");
  console.log("  Telegram will start automatically with `whs start`.\n");

  return true;
}
