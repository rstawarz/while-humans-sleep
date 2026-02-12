/**
 * Dashboard — main ink component for `whs start`.
 *
 * Combines a scrolling event log (via ink's <Static>) with a
 * persistent bottom panel showing active agents and status.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, Static } from "ink";
import type { Dispatcher } from "../dispatcher.js";
import type { TUILogger, LogEntry } from "./tui-logger.js";
import type { ActiveWork } from "../types.js";
import { readAgentLog } from "../agent-log.js";
import type { AgentLogEvent } from "../agent-log.js";
import { VERSION } from "../version.js";
import { AgentPanel } from "./AgentPanel.js";

interface AgentActivity {
  summary: string;
}

interface DashboardProps {
  dispatcher: Dispatcher;
  logger: TUILogger;
  maxTotal: number;
}

function formatUptime(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatActivity(event: AgentLogEvent): string {
  if (event.type === "tool") {
    const name = event.name ?? "Tool";
    const input = event.input ? `: ${event.input}` : "";
    const full = `${name}${input}`;
    return full.length > 60 ? full.slice(0, 57) + "..." : full;
  }
  if (event.type === "text" && event.text) {
    return event.text.length > 60 ? event.text.slice(0, 57) + "..." : event.text;
  }
  return "Working...";
}

function LogLine({ entry }: { entry: LogEntry }): React.ReactElement {
  const color =
    entry.level === "error" ? "red" : entry.level === "warn" ? "yellow" : undefined;

  return (
    <Text color={color}>{"  " + entry.text}</Text>
  );
}

export function Dashboard({ dispatcher, logger, maxTotal }: DashboardProps): React.ReactElement {
  const [logs, setLogs] = useState<readonly LogEntry[]>(logger.getEntries());
  const [active, setActive] = useState<ActiveWork[]>([]);
  const [pendingQuestionCount, setPendingQuestionCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [startedAt, setStartedAt] = useState(new Date());
  const [todayCost, setTodayCost] = useState(0);
  const [agentActivity, setAgentActivity] = useState<Map<string, AgentActivity>>(new Map());

  // Subscribe to new log entries
  useEffect(() => {
    logger.subscribe(() => {
      setLogs([...logger.getEntries()]);
    });
  }, [logger]);

  // Poll dispatcher status + agent activity every 2s
  useEffect(() => {
    function poll(): void {
      try {
        const status = dispatcher.getStatus();
        setActive(status.active);
        setPendingQuestionCount(status.pendingQuestionCount);
        setPaused(status.paused);
        setStartedAt(status.startedAt);
        setTodayCost(status.todayCost);

        // Read latest activity for each active agent
        const activity = new Map<string, AgentActivity>();
        for (const work of status.active) {
          const events = readAgentLog(work.workflowStepId, 1);
          if (events.length > 0) {
            activity.set(work.workflowStepId, {
              summary: formatActivity(events[0]),
            });
          }
        }
        setAgentActivity(activity);
      } catch {
        // Dispatcher may not be ready yet
      }
    }

    // Initial poll
    poll();

    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [dispatcher]);

  return (
    <Box flexDirection="column">
      <Static items={logs as LogEntry[]}>
        {(entry: LogEntry) => <LogLine key={entry.id} entry={entry} />}
      </Static>

      <Box borderStyle="single" flexDirection="column">
        {/* Header */}
        <Box paddingX={1} justifyContent="space-between">
          <Text bold>
            {"\uD83C\uDF19 While Humans Sleep v" + VERSION}
          </Text>
          <Text dimColor>
            {"\u23F1 " + formatUptime(startedAt) + "  $" + todayCost.toFixed(2)}
          </Text>
        </Box>

        {/* Agent panel */}
        <AgentPanel
          active={active}
          maxTotal={maxTotal}
          pendingQuestionCount={pendingQuestionCount}
          paused={paused}
          agentActivity={agentActivity}
        />
      </Box>
    </Box>
  );
}
