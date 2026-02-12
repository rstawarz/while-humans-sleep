/**
 * AgentPanel — renders active agents with their latest activity.
 */

import React from "react";
import { Box, Text } from "ink";
import type { ActiveWork } from "../types.js";

interface AgentActivity {
  /** Human-readable summary of latest tool/text */
  summary: string;
}

interface AgentPanelProps {
  active: ActiveWork[];
  maxTotal: number;
  pendingQuestionCount: number;
  paused: boolean;
  agentActivity: Map<string, AgentActivity>;
}

function formatDuration(startedAt: Date): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export function AgentPanel({
  active,
  maxTotal,
  pendingQuestionCount,
  paused,
  agentActivity,
}: AgentPanelProps): React.ReactElement {
  if (paused) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="yellow">
          {"  \u23F8 Paused"}
        </Text>
      </Box>
    );
  }

  if (active.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{"  Active Agents (0/" + maxTotal + ")"}</Text>
        <Text dimColor>{"  Waiting for ready work"}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{"  Active Agents (" + active.length + "/" + maxTotal + ")"}</Text>
      <Text>{""}</Text>
      {active.map((work) => {
        const duration = formatDuration(work.startedAt);
        const cost = "$" + work.costSoFar.toFixed(2);
        const activity = agentActivity.get(work.workflowStepId);
        const activityText = activity?.summary || "Starting...";

        return (
          <Box key={work.workflowStepId} flexDirection="column" marginBottom={1}>
            <Text>
              {"  \u2699 "}
              <Text bold>{work.agent}</Text>
              {"  " + work.workItem.project + "/" + work.workItem.id}
            </Text>
            <Text dimColor>
              {"    \u21B3 " + activityText}
              {"              " + duration + " \u00B7 " + cost}
            </Text>
          </Box>
        );
      })}
      {pendingQuestionCount > 0 && (
        <Text color="yellow">
          {"  \u2753 " + pendingQuestionCount + " pending question" + (pendingQuestionCount > 1 ? "s" : "")}
        </Text>
      )}
    </Box>
  );
}
