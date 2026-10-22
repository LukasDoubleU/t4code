import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadTailMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const THREAD_TAIL_DEFAULT_MESSAGES = 6;
export const THREAD_TAIL_MAX_MESSAGES = 12;
/** A tail previews messages; the thread holds the rest. */
export const THREAD_TAIL_MAX_TEXT_CHARS = 4_000;

export function clampThreadTailLimit(limit: number | undefined): number {
  if (limit === undefined) return THREAD_TAIL_DEFAULT_MESSAGES;
  return Math.min(THREAD_TAIL_MAX_MESSAGES, Math.max(1, Math.floor(limit)));
}

/**
 * The rows of a thread's tail, oldest first: its last `limit` user messages and replies. A run's
 * reply is its last assistant message; the ones before it narrate the work on the way.
 */
export function selectThreadTailRows<
  Row extends { readonly item: { readonly type: string; readonly runId: string | null } },
>(rows: ReadonlyArray<Row>, limit: number): Row[] {
  const tail: Row[] = [];
  const repliedRuns = new Set<string>();
  for (let index = rows.length - 1; index >= 0 && tail.length < limit; index -= 1) {
    const row = rows[index]!;
    const { type, runId } = row.item;
    if (type === "assistant_message") {
      if (runId !== null) {
        if (repliedRuns.has(runId)) continue;
        repliedRuns.add(runId);
      }
    } else if (type !== "user_message") {
      continue;
    }
    tail.unshift(row);
  }
  return tail;
}

function clampText(text: string): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= THREAD_TAIL_MAX_TEXT_CHARS) return { text, truncated: false };
  let end = THREAD_TAIL_MAX_TEXT_CHARS;
  // Never split a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

export function threadTailMessage(
  row: OrchestrationV2ProjectedTurnItem,
): OrchestrationV2ThreadTailMessage | null {
  const { item } = row;
  if (item.type !== "user_message" && item.type !== "assistant_message") return null;
  const { text, truncated } = clampText(item.text);
  return {
    itemId: row.sourceItemId,
    messageId: item.messageId,
    runId: item.runId,
    role: item.type === "user_message" ? "user" : "assistant",
    text,
    textTruncated: truncated,
    streaming: item.type === "assistant_message" && item.streaming,
    ...(item.type === "user_message"
      ? {
          createdBy: item.createdBy,
          creationSource: item.creationSource,
          ...(item.scheduledTaskId === undefined ? {} : { scheduledTaskId: item.scheduledTaskId }),
          ...(item.senderThreadId === undefined ? {} : { senderThreadId: item.senderThreadId }),
          ...(item.sentFrom === undefined ? {} : { sentFrom: item.sentFrom }),
        }
      : {}),
    createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
  };
}

/** The tail of a timeline already loaded, such as a bounded snapshot's window. */
export function threadTailFromRows(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  limit: number,
): OrchestrationV2ThreadTailMessage[] {
  return selectThreadTailRows(rows, clampThreadTailLimit(limit)).flatMap((row) => {
    const message = threadTailMessage(row);
    return message === null ? [] : [message];
  });
}
