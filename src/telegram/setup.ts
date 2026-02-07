/**
 * Telegram Setup Wizard
 *
 * Interactive setup for configuring Telegram bot integration.
 * Guides user through:
 * 1. Creating a bot with @BotFather
 * 2. Getting the bot token
 * 3. Getting their chat ID
 * 4. Validating the configuration
 */

import { Bot } from "grammy";
import { updateConfig } from "../config.js";

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

  // Save to config
  updateConfig({
    telegram: { botToken, chatId },
    notifier: "telegram",
  });

  console.log("\n  Configuration saved to .whs/config.json");
  console.log("  Telegram will start automatically with `whs start`.\n");

  return true;
}
