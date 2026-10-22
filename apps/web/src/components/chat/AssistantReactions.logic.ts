import type {
  OrchestrationV2MessageReactionEmoji,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";

import { formatDayAwareTimestamp } from "../../timestampFormat";

type ReplyItem = Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }>;

export interface ReactableReply {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  /** The time the reply's footer shows. */
  readonly repliedAt: string;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

function isFinishedReply(item: OrchestrationV2TurnItem): item is ReplyItem {
  return item.type === "assistant_message" && !item.streaming;
}

/** A reply the user can react to: a finished reply of the thread itself, not one it inherited. */
export function reactableReply(
  projectedItem: OrchestrationV2ProjectedTurnItem | undefined,
): ReactableReply | null {
  if (
    projectedItem === undefined ||
    projectedItem.visibility !== "local" ||
    !isFinishedReply(projectedItem.item)
  ) {
    return null;
  }
  return {
    threadId: projectedItem.sourceThreadId,
    itemId: projectedItem.item.id,
    repliedAt: DateTime.formatIso(projectedItem.item.updatedAt),
  };
}

/** Whether the silent 👍 sets or clears the reaction. */
export function thumbsUpAction(reactions: ReadonlyArray<OrchestrationV2MessageReactionEmoji> = []) {
  const reacted = reactions.includes("👍");
  return {
    reacted,
    label: reacted ? "Remove 👍" : "React 👍 (no reply)",
  } as const;
}

/**
 * The reply a Go ahead from the keyboard approves: the reply of the thread's latest finished
 * turn, the newest one with a footer. Null while the thread has none.
 */
export function goAheadTarget(
  projection: {
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
  },
  threadId: ThreadId,
): ReactableReply | null {
  const activeRunIds = new Set(
    projection.runs.flatMap((run) => (ACTIVE_RUN_STATUSES.has(run.status) ? [run.id] : [])),
  );
  const reply = projection.turnItems.findLast(
    (item): item is ReplyItem =>
      item.threadId === threadId &&
      isFinishedReply(item) &&
      (item.runId === null || !activeRunIds.has(item.runId)),
  );
  return reply === undefined
    ? null
    : { threadId, itemId: reply.id, repliedAt: DateTime.formatIso(reply.updatedAt) };
}

/** The thread's newest reply, finished or still streaming. */
export function latestReplyItemId(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  threadId: ThreadId,
): TurnItemId | null {
  return (
    turnItems.findLast((item) => item.threadId === threadId && item.type === "assistant_message")
      ?.id ?? null
  );
}

/** What "Go ahead" sends. A reply other than the latest one is named by its time. */
export function goAheadText(input: {
  readonly latest: boolean;
  readonly repliedAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly nowMs?: number;
}): string {
  if (input.latest) return "👍 Go ahead.";
  const time = formatDayAwareTimestamp(input.repliedAt, input.timestampFormat, input.nowMs);
  return `👍 Go ahead with your reply from ${time}.`;
}
