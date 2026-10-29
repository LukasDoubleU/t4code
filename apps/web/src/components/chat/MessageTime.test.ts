import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ChatMessage } from "../../types";
import {
  messageTimeLabel,
  parseTurnFoldReplyKey,
  subscribeToRelativeTimeChanges,
  tallTurnFoldReplyKey,
  turnFoldReplyKey,
} from "./MessageTime";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

const SENT_AT = "2026-10-21T12:00:00.000Z";
const SENT_AT_MS = Date.parse(SENT_AT);
const MINUTE_MS = 60_000;

describe("messageTimeLabel", () => {
  it("reads relative from just now to days", () => {
    expect(messageTimeLabel(SENT_AT, "relative", "24-hour", SENT_AT_MS + 30_000)).toBe("just now");
    expect(messageTimeLabel(SENT_AT, "relative", "24-hour", SENT_AT_MS + 10 * MINUTE_MS)).toBe(
      "10m ago",
    );
    expect(messageTimeLabel(SENT_AT, "relative", "24-hour", SENT_AT_MS + 3 * 60 * MINUTE_MS)).toBe(
      "3h ago",
    );
    expect(
      messageTimeLabel(SENT_AT, "relative", "24-hour", SENT_AT_MS + 2 * 24 * 60 * MINUTE_MS),
    ).toBe("2d ago");
  });

  it("reads the time of day as the clock choice", () => {
    const sentAt = new Date(2026, 9, 21, 14, 5).toISOString();
    const sameDay = new Date(2026, 9, 21, 18, 0).getTime();
    expect(messageTimeLabel(sentAt, "clock", "24-hour", sameDay)).toBe("14:05");
  });
});

describe("subscribeToRelativeTimeChanges", () => {
  function withFakeClock(nowMs: number, run: () => void) {
    vi.useFakeTimers({ now: nowMs });
    try {
      run();
    } finally {
      vi.useRealTimers();
    }
  }

  it("wakes once per label change and stops when unsubscribed", () => {
    withFakeClock(SENT_AT_MS + 30_000, () => {
      const onChange = vi.fn();
      const unsubscribe = subscribeToRelativeTimeChanges(SENT_AT, onChange);
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(29_999);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(messageTimeLabel(SENT_AT, "relative", "24-hour")).toBe("1m ago");

      vi.advanceTimersByTime(MINUTE_MS);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(messageTimeLabel(SENT_AT, "relative", "24-hour")).toBe("2m ago");
      expect(vi.getTimerCount()).toBe(1);

      unsubscribe();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("wakes hourly once the label counts hours", () => {
    withFakeClock(SENT_AT_MS + 90 * MINUTE_MS, () => {
      const onChange = vi.fn();
      const unsubscribe = subscribeToRelativeTimeChanges(SENT_AT, onChange);

      vi.advanceTimersByTime(30 * MINUTE_MS - 1);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(messageTimeLabel(SENT_AT, "relative", "24-hour")).toBe("2h ago");
      unsubscribe();
    });
  });
});

const RUN = RunId.make("run-1");
const OTHER_RUN = RunId.make("run-2");

function assistantMessage(id: string, runId: RunId, streaming = false): ChatMessage {
  return {
    id: MessageId.make(id),
    role: "assistant",
    text: "Done.",
    runId,
    streaming,
    createdAt: SENT_AT,
    updatedAt: SENT_AT,
  };
}

function replyRow(message: ChatMessage, showAssistantMeta = true): MessagesTimelineRow {
  return {
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    showAssistantMeta,
    showAssistantCopyButton: showAssistantMeta,
    assistantCopyStreaming: false,
  };
}

function foldRow(runId: RunId): MessagesTimelineRow {
  return {
    kind: "turn-fold",
    id: `turn-fold:${runId}`,
    createdAt: SENT_AT,
    runId,
    label: "Worked for 26s",
    expanded: false,
  };
}

describe("turn fold replies", () => {
  it("moves a settled reply's time into its run's Worked for line", () => {
    const reply = assistantMessage("reply", RUN);
    const replies = parseTurnFoldReplyKey(
      turnFoldReplyKey([
        foldRow(RUN),
        replyRow(assistantMessage("commentary", RUN), false),
        replyRow(reply),
        replyRow(assistantMessage("unfolded", OTHER_RUN)),
      ]),
    );
    expect([...replies]).toEqual([[RUN, { messageId: reply.id, at: reply.updatedAt }]]);
  });

  it("counts a reply whose footer moved below trailing work", () => {
    const reply = assistantMessage("reply", RUN);
    const key = turnFoldReplyKey([
      foldRow(RUN),
      replyRow(reply, false),
      {
        kind: "assistant-meta",
        id: `meta:${reply.id}`,
        createdAt: reply.createdAt,
        message: reply,
        showAssistantCopyButton: true,
        assistantCopyStreaming: false,
      },
    ]);
    expect(parseTurnFoldReplyKey(key).get(RUN)?.messageId).toBe(reply.id);
  });

  it("keeps the same key while another reply streams", () => {
    const settled = [foldRow(RUN), replyRow(assistantMessage("reply", RUN))];
    const streaming = replyRow(assistantMessage("next", OTHER_RUN, true));
    expect(turnFoldReplyKey([...settled, streaming])).toBe(turnFoldReplyKey(settled));
    expect(turnFoldReplyKey([replyRow(assistantMessage("reply", RUN))])).toBe("");
  });
});

describe("tallTurnFoldReplyKey", () => {
  const replies = parseTurnFoldReplyKey(
    turnFoldReplyKey([
      foldRow(RUN),
      replyRow(assistantMessage("long", RUN)),
      foldRow(OTHER_RUN),
      replyRow(assistantMessage("short", OTHER_RUN)),
    ]),
  );

  it("keeps the end time for replies taller than the visible area only", () => {
    const heights = new Map([
      ["long", 900],
      ["short", 400],
    ]);
    expect(tallTurnFoldReplyKey(replies, (id) => heights.get(id), 600)).toBe("long");
    expect(tallTurnFoldReplyKey(replies, (id) => heights.get(id), 900)).toBe("");
    expect(tallTurnFoldReplyKey(replies, (id) => heights.get(id), 300)).toBe("long\nshort");
  });

  it("treats unmeasured rows and an unmeasured viewport as fitting", () => {
    expect(tallTurnFoldReplyKey(replies, () => undefined, 600)).toBe("");
    expect(tallTurnFoldReplyKey(replies, () => 900, 0)).toBe("");
  });
});
