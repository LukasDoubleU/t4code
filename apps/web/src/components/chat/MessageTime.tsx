import type { MessageTimeStyle, TimestampFormat } from "@t3tools/contracts/settings";
import { useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";
import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatRelativeTimeLabel,
  msUntilRelativeTimeChange,
} from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export function messageTimeLabel(
  isoDate: string,
  style: MessageTimeStyle,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): string {
  return style === "relative"
    ? formatRelativeTimeLabel(isoDate, nowMs)
    : formatDayAwareTimestamp(isoDate, timestampFormat, nowMs);
}

/** Calls `onChange` when the relative label next changes: one timer per label, never a tick. */
export function subscribeToRelativeTimeChanges(isoDate: string, onChange: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const delayMs = msUntilRelativeTimeChange(isoDate);
    if (delayMs === null) return;
    timer = setTimeout(() => {
      onChange();
      schedule();
    }, delayMs);
  };
  schedule();
  return () => clearTimeout(timer);
}

const NO_CHANGES = () => () => {};

/** A chat message's time, with the exact date and time in its tooltip. */
export function MessageTime(props: {
  isoDate: string;
  style: MessageTimeStyle;
  timestampFormat: TimestampFormat;
  className?: string;
}) {
  const { isoDate, style, timestampFormat } = props;
  const label = useSyncExternalStore(
    style === "relative"
      ? (onChange) => subscribeToRelativeTimeChanges(isoDate, onChange)
      : NO_CHANGES,
    () => messageTimeLabel(isoDate, style, timestampFormat),
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("tabular-nums", props.className)} />}>
        {label}
      </TooltipTrigger>
      <TooltipPopup>
        {formatChatTimestampTooltip(props.isoDate, props.timestampFormat)}
      </TooltipPopup>
    </Tooltip>
  );
}

export interface TurnFoldReply {
  readonly messageId: string;
  readonly at: string;
}

/**
 * The settled reply of each run that has a "Worked for" line, as a string. Rows change with
 * every streamed token; the string stays equal until a fold's reply changes, so the compiler
 * keeps the parsed map, and the row context holding it, unchanged.
 */
export function turnFoldReplyKey(rows: ReadonlyArray<MessagesTimelineRow>): string {
  const foldRunIds = new Set<string>();
  for (const row of rows) {
    if (row.kind === "turn-fold") foldRunIds.add(row.runId);
  }
  if (foldRunIds.size === 0) return "";
  const lines: string[] = [];
  for (const row of rows) {
    const carriesReplyMeta =
      row.kind === "assistant-meta" ||
      (row.kind === "message" && row.message.role === "assistant" && row.showAssistantMeta);
    if (!carriesReplyMeta || row.message.streaming) continue;
    const runId = row.message.runId;
    if (!runId || !foldRunIds.has(runId)) continue;
    lines.push(`${runId}\t${row.message.id}\t${row.message.updatedAt}`);
  }
  return lines.join("\n");
}

export function parseTurnFoldReplyKey(key: string): ReadonlyMap<string, TurnFoldReply> {
  const replies = new Map<string, TurnFoldReply>();
  for (const line of key.split("\n")) {
    const [runId, messageId, at] = line.split("\t");
    if (runId && messageId && at) replies.set(runId, { messageId, at });
  }
  return replies;
}

/**
 * Fold replies whose measured row is taller than the visible chat area, so their header time is
 * out of view while their end is on screen. A string that stays equal until the set changes;
 * unmeasured rows count as short.
 */
export function tallTurnFoldReplyKey(
  replies: ReadonlyMap<string, TurnFoldReply>,
  measuredHeight: (messageId: string) => number | undefined,
  visibleHeight: number,
): string {
  if (visibleHeight <= 0) return "";
  const tallIds: string[] = [];
  for (const { messageId } of replies.values()) {
    if ((measuredHeight(messageId) ?? 0) > visibleHeight) tallIds.push(messageId);
  }
  return tallIds.join("\n");
}
