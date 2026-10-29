import { describe, expect, it } from "vite-plus/test";

import type { ContextMenuItem } from "@t3tools/contracts";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuId,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

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

function moreIds(state: ThreadActionMenuState): string[] {
  const more = buildThreadActionMenuItems(state).find((item) => item.id === "more");
  return (more?.children ?? []).map((item) => item.id);
}

function flatten(
  items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
}

describe("buildThreadActionMenuItems", () => {
  it("keeps everyday actions on top and the rest under More", () => {
    const state: ThreadActionMenuState = {
      ...baseState,
      branch: "main",
      projectFilter: { label: "Docs", isActive: false },
      isPinned: true,
      canStartTopic: true,
      hasOwnIcon: true,
      hasMemory: true,
      supports: { ...baseState.supports, freshStart: true, accountFailover: true, icons: true },
    };
    expect(ids(state)).toEqual([
      "new-thread-on-branch",
      "start-topic",
      "unpin",
      "rename",
      "change-icon",
      "use-project-icon",
      "settle",
      "snooze",
      "mark-unread",
      "copy-thread-id",
      "more",
    ]);
    expect(moreIds(state)).toEqual([
      "open-memory",
      "fresh-start",
      "regenerate-title",
      "filter-by-project",
      "auto-settle",
      "account-failover",
      "copy",
      "project-settings",
      "archive",
      "delete",
    ]);
    const more = buildThreadActionMenuItems(state).find((item) => item.id === "more");
    expect(more?.children?.find((item) => item.id === "copy")?.children?.map((c) => c.id)).toEqual([
      "copy-path",
      "copy-branch",
      "copy-thread",
    ]);
    expect(more?.children?.find((item) => item.id === "archive")?.separatorBefore).toBe(true);
  });

  it("offers Start new topic only on an expert row, and Use project icon only over an own icon", () => {
    expect(ids(baseState)).not.toContain("start-topic");
    expect(ids({ ...baseState, isPinned: true, canStartTopic: true })).toContain("start-topic");
    const icons = { ...baseState.supports, icons: true };
    expect(ids({ ...baseState, supports: icons })).toContain("change-icon");
    expect(ids({ ...baseState, supports: icons })).not.toContain("use-project-icon");
    expect(ids({ ...baseState, supports: icons, hasOwnIcon: true })).toContain("use-project-icon");
    // A server that keeps no thread icons.
    expect(ids({ ...baseState, hasOwnIcon: true })).not.toContain("change-icon");
  });

  it.each([false, true])(
    "disables both lifecycle directions without permission, under More too (reversed: %s)",
    (reversed) => {
      const items = flatten(
        buildThreadActionMenuItems({
          ...baseState,
          canOperate: false,
          isPinned: reversed,
          canStartTopic: reversed,
          isSettled: reversed,
          isSnoozed: reversed,
          supports: { ...baseState.supports, icons: true },
        }),
      );
      const disabled = items.filter((item) => item.disabled).map((item) => item.id);
      expect(disabled).toEqual(
        reversed
          ? [
              "start-topic",
              "unpin",
              "rename",
              "change-icon",
              "unsettle",
              "unsnooze",
              "regenerate-title",
              "auto-settle",
              "auto-settle:enabled",
              "auto-settle:disabled",
              "archive",
              "delete",
            ]
          : [
              "pin",
              "rename",
              "change-icon",
              "settle",
              "snooze",
              "snooze:hour",
              "snooze:custom",
              "regenerate-title",
              "auto-settle",
              "auto-settle:enabled",
              "auto-settle:disabled",
              "archive",
              "delete",
            ],
      );
      // Reading and copying need no permission.
      expect(disabled).not.toContain("more");
      expect(disabled).not.toContain("copy-thread-id");
      expect(disabled).not.toContain("copy-path");
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
    const archiveItem = flatten(buildThreadActionMenuItems({ ...baseState, isRunning: true })).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});
