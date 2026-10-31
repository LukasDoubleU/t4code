import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

import {
  isTimelineMinimapRangeVisible,
  resolveTimelineMinimapMarkCapacity,
} from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapItems,
  groupTimelineMinimapItems,
  resolveTimelineMinimapPreview,
  type TimelineMinimapItem,
  type TimelineMinimapMark,
} from "./timelineMinimapItems";

function makeItems(authoredAt: ReadonlyArray<number>, count: number): TimelineMinimapItem[] {
  const authored = new Set(authoredAt);
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    rowIndex: index * 3,
    userAuthored: authored.has(index),
    userText: `message ${index}`,
    assistantText: null,
  }));
}

function flattenIds(marks: ReadonlyArray<TimelineMinimapMark>) {
  return marks.flatMap((mark) => mark.items.map((item) => item.id));
}

describe("groupTimelineMinimapItems", () => {
  it("keeps one mark per turn while the rail has room", () => {
    const items = makeItems([0, 2], 12);
    const capacity = resolveTimelineMinimapMarkCapacity((items.length - 1) * 8);

    for (const marks of [
      groupTimelineMinimapItems(items, capacity),
      groupTimelineMinimapItems(items, null),
    ]) {
      expect(marks.map((mark) => mark.id)).toEqual(items.map((item) => item.id));
      expect(marks.every((mark) => mark.items.length === 1)).toBe(true);
    }
  });

  it("groups a long thread to fit the rail and keeps every turn in order", () => {
    const items = makeItems([0, 40, 41, 150, 299], 300);
    const capacity = resolveTimelineMinimapMarkCapacity(600);

    const marks = groupTimelineMinimapItems(items, capacity);

    expect(capacity).toBe(76);
    expect(marks.length).toBeLessThanOrEqual(76);
    expect(marks.length).toBeGreaterThan(60);
    expect(flattenIds(marks)).toEqual(items.map((item) => item.id));
    expect(marks.map((mark) => mark.firstItemIndex)).toEqual(
      marks.map((mark) => items.indexOf(mark.items[0]!)),
    );
  });

  it("keeps the user's own messages as single marks", () => {
    const authoredAt = [0, 40, 41, 150, 299];
    const items = makeItems(authoredAt, 300);

    const marks = groupTimelineMinimapItems(items, 76);

    for (const index of authoredAt) {
      const mark = marks.find((candidate) => candidate.items.includes(items[index]!));
      expect(mark?.items).toEqual([items[index]]);
    }
    expect(
      marks.filter((mark) => mark.items.length > 1).every((mark) => mark.items.length <= 5),
    ).toBe(true);
  });

  it("groups the user's own messages too when they alone overflow the rail", () => {
    const items = makeItems(
      Array.from({ length: 200 }, (_, index) => index),
      200,
    );

    const marks = groupTimelineMinimapItems(items, 50);

    expect(marks).toHaveLength(50);
    expect(marks.every((mark) => mark.items.length === 4)).toBe(true);
    expect(flattenIds(marks)).toEqual(items.map((item) => item.id));
  });
});

describe("timeline minimap groups", () => {
  it("previews a group as its turn count and first and last message", () => {
    const items = makeItems([], 300);
    const group = groupTimelineMinimapItems(items, 76).find((mark) => mark.items.length > 1);

    expect(resolveTimelineMinimapPreview(group ?? null)).toEqual({
      kind: "group",
      turnCount: group?.items.length,
      firstUserText: group?.items[0]?.userText,
      lastUserText: group?.items.at(-1)?.userText,
    });
  });

  it("counts a group in view while any row of its range is visible", () => {
    expect(isTimelineMinimapRangeVisible(10, 30, 18, 22)).toBe(true);
    expect(isTimelineMinimapRangeVisible(10, 30, 28, 40)).toBe(true);
    expect(isTimelineMinimapRangeVisible(10, 30, 31, 40)).toBe(false);
    expect(isTimelineMinimapRangeVisible(10, 30, null, null)).toBe(false);
  });
});

describe("deriveTimelineMinimapItems", () => {
  it.each(["", "Ultrathink:\n"])(
    "omits bootstrap text from the minimap label and tooltip (%j)",
    (prefix) => {
      const at = "2026-10-01T00:00:00Z";
      const items = deriveTimelineMinimapItems([
        {
          kind: "message",
          id: "image-only",
          createdAt: at,
          showAssistantMeta: false,
          showAssistantCopyButton: false,
          assistantCopyStreaming: false,
          message: {
            id: MessageId.make("image-only"),
            role: "user",
            text: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
            runId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ]);
      expect(items).toEqual([
        { id: "image-only", rowIndex: 0, userAuthored: true, userText: "", assistantText: null },
      ]);
      expect(
        resolveTimelineMinimapPreview({ id: "image-only", firstItemIndex: 0, items }),
      ).toMatchObject({ kind: "turn", userText: null });
    },
  );
});

describe("resolveTimelineMinimapPreview", () => {
  it("previews a thread autolink as prose, not its URL", () => {
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      firstItemIndex: 0,
      items: [
        {
          id: "turn-1",
          rowIndex: 0,
          userAuthored: true,
          userText: null,
          assistantText:
            "Started <t3-thread://v2/env-1/thread-1> and [Fix CI](t3-thread://v2/env-1/t2).",
        },
      ],
    });
    expect(preview?.kind === "turn" ? preview.assistantText : null).toBe(
      "Started a thread and Fix CI.",
    );
  });
});
