/**
 * Question Service - Reusable logic for handling dispatcher questions
 *
 * This module provides a clean interface for working with questions that
 * agents have asked. It's designed to be used by both the CLI chat mode
 * and future integrations like Slack.
 */

import { beads } from "./beads/index.js";
import { loadConfig, expandPath } from "./config.js";
import { markStepInProgress } from "./workflow.js";
import { resumeWithAnswer } from "./agent-runner.js";
import { getHandoff } from "./handoff.js";
import type { QuestionBeadData, Handoff, Question } from "./types.js";

/**
 * A formatted question ready for display
 */
export interface FormattedQuestion {
  beadId: string;
  project: string;
  stepId: string;
  epicId: string;
  createdAt: Date;
  context: string;
  questions: Question[];
  sessionId: string;
  worktree: string;
}

/**
 * Result of submitting an answer to a question
 */
export interface AnswerResult {
  success: boolean;
  handoff?: Handoff;
  error?: string;
}

/**
 * Get the oldest pending question
 *
 * Beads returns questions sorted by created date (oldest first),
 * so we simply take the first one.
 */
export function getOldestQuestion(): FormattedQuestion | null {
  const config = loadConfig();
  const orchestratorPath = expandPath(config.orchestratorPath);

  const pending = beads.listPendingQuestions(orchestratorPath);
  if (pending.length === 0) return null;

  // Already sorted by beads - take first (oldest)
  const oldest = pending[0];
  const data = beads.parseQuestionData(oldest);

  return {
    beadId: oldest.id,
    project: data.metadata.project,
    stepId: data.metadata.step_id,
    epicId: data.metadata.epic_id,
    createdAt: new Date(oldest.created_at),
    context: data.context,
    questions: data.questions,
    sessionId: data.metadata.session_id,
    worktree: data.metadata.worktree,
  };
}

/**
 * Format a time duration in human-readable form
 */
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(seconds / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Format question for CLI display
 */
export function formatQuestionForDisplay(q: FormattedQuestion): string {
  const lines: string[] = [];
  const timeAgo = formatTimeAgo(q.createdAt);

  lines.push(`Question from ${q.project} (${q.beadId})`);
  lines.push(`   Step: ${q.stepId.split(".").pop()}`);
  lines.push(`   Asked: ${timeAgo}`);
  lines.push("");

  if (q.context) {
    lines.push("   Context:");
    // Show up to 5 lines of context
    const contextLines = q.context.split("\n").slice(0, 5);
    for (const line of contextLines) {
      lines.push(`   ${line}`);
    }
    if (q.context.split("\n").length > 5) {
      lines.push("   ...");
    }
    lines.push("");
  }

  for (const question of q.questions) {
    lines.push(`   Q: ${question.question}`);
    if (question.options && question.options.length > 0) {
      question.options.forEach((opt, i) => {
        const desc = opt.description ? ` (${opt.description})` : "";
        lines.push(`      ${i + 1}. ${opt.label}${desc}`);
      });
    }
  }

  return lines.join("\n");
}

/**
 * Submit an answer to a question and resume the agent
 */
export async function submitAnswer(
  questionId: string,
  answer: string
): Promise<AnswerResult> {
  const config = loadConfig();
  const orchestratorPath = expandPath(config.orchestratorPath);

  try {
    // Get question data before closing
    const pending = beads.listPendingQuestions(orchestratorPath);
    const questionBead = pending.find((b) => b.id === questionId);
    if (!questionBead) {
      return { success: false, error: "Question not found" };
    }

    const questionData = beads.parseQuestionData(questionBead);

    // Mark step in progress (prevents dispatcher race)
    markStepInProgress(questionData.metadata.step_id);

    // Close the question bead
    beads.answerQuestion(questionId, answer, orchestratorPath);

    // Resume agent session
    const result = await resumeWithAnswer(
      questionData.metadata.session_id,
      answer,
      {
        cwd: questionData.metadata.worktree,
        maxTurns: 50,
      }
    );

    // Get handoff from result
    const handoff = await getHandoff(
      result.output,
      result.sessionId,
      questionData.metadata.worktree
    );

    return { success: true, handoff };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
