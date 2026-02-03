/**
 * CLI Notifier - MVP notification via console output
 */

import type { Notifier, PendingQuestion, ActiveWork } from "../types.js";

export class CLINotifier implements Notifier {
  async notifyQuestion(question: PendingQuestion): Promise<void> {
    console.log("\n" + "=".repeat(60));
    console.log(`❓ QUESTION from ${question.project}/${question.workItemId}`);
    console.log(`Context: ${question.context}`);
    console.log("-".repeat(60));

    for (const q of question.questions) {
      console.log(`Q: ${q.question}`);
      if (q.options && q.options.length > 0) {
        q.options.forEach((opt, i) => {
          console.log(`  ${i + 1}. ${opt.label}${opt.description ? ` - ${opt.description}` : ""}`);
        });
      }
    }

    console.log("-".repeat(60));
    console.log(`Answer with: whs answer ${question.id} "your answer"`);
    console.log("=".repeat(60) + "\n");
  }

  async notifyProgress(work: ActiveWork, message: string): Promise<void> {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
    console.log(`[${timestamp}] [${work.workItem.project}/${work.workItem.id}] ${message}`);
  }

  async notifyComplete(work: ActiveWork, result: "done" | "blocked"): Promise<void> {
    const emoji = result === "done" ? "✅" : "🚫";
    console.log(`\n${emoji} ${work.workItem.project}/${work.workItem.id} - ${result.toUpperCase()}`);
    console.log(`   Agent: ${work.agent}`);
    console.log(`   Cost: $${work.costSoFar.toFixed(4)}`);
    console.log(`   Duration: ${this.formatDuration(work.startedAt)}\n`);
  }

  async notifyError(work: ActiveWork, error: Error): Promise<void> {
    console.error(`\n❌ ERROR in ${work.workItem.project}/${work.workItem.id}`);
    console.error(`   Agent: ${work.agent}`);
    console.error(`   Error: ${error.message}\n`);
  }

  async notifyRateLimit(error: Error): Promise<void> {
    console.log("\n" + "=".repeat(60));
    console.log("⚠️  RATE LIMIT HIT - Dispatcher paused");
    console.log(`Error: ${error.message}`);
    console.log("Run 'whs resume' when ready to continue.");
    console.log("=".repeat(60) + "\n");
  }

  private formatDuration(startedAt: Date): string {
    const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
}
