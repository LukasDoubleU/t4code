import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("offers Dismiss first while the thread's agent asks for the user", () => {
    expect(ids({ ...baseState, needsYou: true })[0]).toBe("dismiss-attention");
    expect(ids(baseState)).not.toContain("dismiss-attention");
  });

  it("offers the Background move the sidebar allows, after snooze, also to read-only clients", () => {
    expect(ids(baseState)).not.toContain("move-to-background");
    const toBackground = buildThreadActionMenuItems({
      ...baseState,
      background: { placement: "background", available: true },
    });
    const snoozeIndex = toBackground.findIndex((item) => item.id === "snooze");
    expect(toBackground[snoozeIndex + 1]).toMatchObject({
      id: "move-to-background",
      label: "Move to background",
      icon: "send-to-back",
      disabled: false,
    });
    const toFront = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      background: { placement: "front", available: true },
    }).find((item) => item.id === "bring-to-front");
    expect(toFront).toMatchObject({ label: "Bring to front", icon: "bring-to-front" });
    expect(toFront?.disabled).toBeFalsy();
  });

  it("disables Move to background while the move would not take effect", () => {
    const item = buildThreadActionMenuItems({
      ...baseState,
      background: { placement: "background", available: false },
    }).find((candidate) => candidate.id === "move-to-background");
    expect(item?.disabled).toBe(true);
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});
