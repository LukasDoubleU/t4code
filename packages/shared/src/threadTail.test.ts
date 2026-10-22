import { describe, expect, it } from "@effect/vitest";

import {
  clampThreadTailLimit,
  selectThreadTailRows,
  THREAD_TAIL_MAX_MESSAGES,
} from "./threadTail.ts";

const row = (id: string, type: string, runId: string | null) => ({ id, item: { type, runId } });

describe("selectThreadTailRows", () => {
  it("keeps what the thread was told and each run's last reply, oldest first", () => {
    const rows = [
      row("ask", "user_message", "run-1"),
      row("narration", "assistant_message", "run-1"),
      row("tool", "command_execution", "run-1"),
      row("steer", "user_message", "run-1"),
      row("reply", "assistant_message", "run-1"),
      row("plan", "proposed_plan", "run-1"),
      row("notice", "assistant_message", null),
      row("other-notice", "assistant_message", null),
    ];
    expect(selectThreadTailRows(rows, 10).map((selected) => selected.id)).toEqual([
      "ask",
      "steer",
      "reply",
      "notice",
      "other-notice",
    ]);
    expect(selectThreadTailRows(rows, 2).map((selected) => selected.id)).toEqual([
      "notice",
      "other-notice",
    ]);
  });
});

describe("clampThreadTailLimit", () => {
  it("bounds what a reader asks for", () => {
    expect(clampThreadTailLimit(1_000)).toBe(THREAD_TAIL_MAX_MESSAGES);
    expect(clampThreadTailLimit(0)).toBe(1);
    expect(clampThreadTailLimit(2.7)).toBe(2);
  });
});
