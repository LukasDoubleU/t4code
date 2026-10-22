import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems } from "./components/threadActionMenu.logic";
import {
  activeThreadMemoryDirectory,
  activeThreadMemoryPath,
  MEMORY_STALE_TURNS,
  threadMemoryTooltipLabel,
} from "./threadMemory.logic";

const threadId = ThreadId.make("thread:1");
const directory = "/home/me/.t3/userdata/memory";

const menuState: Parameters<typeof buildThreadActionMenuItems>[0] = {
  canOperate: false,
  branch: null,
  projectFilter: null,
  isPinned: true,
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
  snoozePresets: [],
};

describe("thread memory indicator", () => {
  it("is active only for a pinned thread on a server that keeps memories with the setting on", () => {
    const config = (pinnedThreadsKeepMemory: boolean, threadMemoryDirectory?: string) => ({
      settings: { pinnedThreadsKeepMemory },
      ...(threadMemoryDirectory === undefined ? {} : { threadMemoryDirectory }),
    });
    const path = (memoryDirectory: string | null, pinned: boolean) =>
      activeThreadMemoryPath({ directory: memoryDirectory, pinned, threadId });

    expect(activeThreadMemoryDirectory(config(true, directory))).toBe(directory);
    expect(path(directory, true)).toBe(`${directory}/thread_1.md`);
    // Unpinned: the memory sleeps.
    expect(path(directory, false)).toBeNull();
    // Setting off: every memory sleeps.
    expect(activeThreadMemoryDirectory(config(false, directory))).toBeNull();
    // A server without memories sends no directory, whatever its decoded setting says.
    expect(activeThreadMemoryDirectory(config(true))).toBeNull();
    expect(activeThreadMemoryDirectory(null)).toBeNull();
  });

  it("says when the file was last updated, or that there are no notes yet", () => {
    const file = { kind: "file", byteLength: 10, modifiedAt: "2026-10-21T11:55:00.000Z" } as const;
    expect(threadMemoryTooltipLabel({ entry: file, failed: false, updated: "5m ago" })).toBe(
      "Memory updated 5m ago",
    );
    expect(threadMemoryTooltipLabel({ entry: null, failed: false, updated: null })).toBe(
      "No notes yet",
    );
    expect(threadMemoryTooltipLabel({ entry: undefined, failed: false, updated: null })).toBe(
      "Memory…",
    );
    expect(threadMemoryTooltipLabel({ entry: undefined, failed: true, updated: null })).toBe(
      "Memory",
    );
  });

  it("says when the memory has not changed for many turns", () => {
    const file = { kind: "file", byteLength: 10, modifiedAt: "2026-10-01T11:55:00.000Z" } as const;
    const label = (entry: typeof file | null, unchangedTurns: number) =>
      threadMemoryTooltipLabel({ entry, failed: false, updated: "3w ago", unchangedTurns });
    expect(label(file, MEMORY_STALE_TURNS - 1)).toBe("Memory updated 3w ago");
    expect(label(file, MEMORY_STALE_TURNS)).toBe(
      `Memory updated 3w ago · unchanged for ${MEMORY_STALE_TURNS} turns`,
    );
    expect(label(null, 31)).toBe("No notes yet after 31 turns");
  });

  it("offers Open memory in the thread menu only while the memory is active", () => {
    const menuIds = (hasMemory: boolean) => buildThreadActionMenuItems({ ...menuState, hasMemory });
    const openMemory = menuIds(true).find((item) => item.id === "open-memory");
    // Reading the memory needs no permission to change threads.
    expect(openMemory).toMatchObject({ label: "Open memory" });
    expect(openMemory?.disabled).toBeUndefined();
    expect(menuIds(false).some((item) => item.id === "open-memory")).toBe(false);
  });

  it("offers Fresh start for a pinned thread, and links the two threads it joins", () => {
    const ids = (state: Partial<Parameters<typeof buildThreadActionMenuItems>[0]>) =>
      buildThreadActionMenuItems({ ...menuState, ...state }).map((item) => item.id);
    const freshStart = { ...menuState.supports, freshStart: true };
    expect(ids({ supports: freshStart })).toContain("fresh-start");
    expect(ids({ supports: freshStart, isPinned: false })).not.toContain("fresh-start");
    // A server without fresh starts.
    expect(ids({})).not.toContain("fresh-start");
    // Fresh start changes threads; following a link only navigates.
    const items = buildThreadActionMenuItems({
      ...menuState,
      supports: freshStart,
      continuedIn: true,
    });
    expect(items.find((item) => item.id === "fresh-start")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "open-continued-in")).toMatchObject({
      label: "Continued in new thread",
    });
    expect(items.find((item) => item.id === "open-continued-in")?.disabled).toBeUndefined();
    expect(ids({ continuedFrom: true })).toContain("open-continued-from");
    expect(ids({})).not.toContain("open-continued-in");
  });
});
