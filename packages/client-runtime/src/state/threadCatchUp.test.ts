import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  closeThreadCatchUp,
  EMPTY_SINCE_LAST_VISIT_MARKER,
  nextSinceLastVisitMarker,
  isThreadCatchUpStale,
  isUserAuthoredMessage,
  requestThreadCatchUp,
  sinceLastVisitIndex,
  threadCatchUpAtom,
  threadCatchUpBasis,
} from "./threadCatchUp.ts";

const brief = (next: string) => ({
  needsYou: null,
  happened: ["Fixed the build"],
  next,
  generatedAt: "2026-10-01T12:00:00.000Z",
});

const thread = {
  itemCount: 12,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  attention: null,
};

describe("thread catch-up cache", () => {
  it("shows a fresh brief again and writes a new one once new items arrive", async () => {
    const registry = AtomRegistry.make();
    const generate = vi.fn(async () => ({ ok: true as const, brief: brief("first") }));
    const basis = threadCatchUpBasis(thread);

    await requestThreadCatchUp({ registry, threadKey: "env:thread", basis, generate });
    closeThreadCatchUp(registry, "env:thread");
    await requestThreadCatchUp({ registry, threadKey: "env:thread", basis, generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(registry.get(threadCatchUpAtom("env:thread"))).toMatchObject({
      open: true,
      brief: { next: "first" },
    });

    const newer = threadCatchUpBasis({ ...thread, itemCount: 13 });
    expect(isThreadCatchUpStale(registry.get(threadCatchUpAtom("env:thread")), newer)).toBe(true);
    generate.mockImplementationOnce(async () => ({ ok: true as const, brief: brief("second") }));
    await requestThreadCatchUp({ registry, threadKey: "env:thread", basis: newer, generate });
    expect(generate).toHaveBeenCalledTimes(2);
    const state = registry.get(threadCatchUpAtom("env:thread"));
    expect(state.brief?.next).toBe("second");
    expect(isThreadCatchUpStale(state, newer)).toBe(false);
  });

  it("goes stale when something starts waiting on the user", () => {
    const basis = threadCatchUpBasis(thread);
    const state = {
      open: true,
      loading: false,
      brief: brief("x"),
      basis,
      error: null,
    };
    expect(isThreadCatchUpStale(state, threadCatchUpBasis(thread))).toBe(false);
    expect(
      isThreadCatchUpStale(state, threadCatchUpBasis({ ...thread, hasPendingApprovals: true })),
    ).toBe(true);
    expect(
      isThreadCatchUpStale(
        state,
        threadCatchUpBasis({ ...thread, attention: { requestedAt: "2026-10-01T12:05:00Z" } }),
      ),
    ).toBe(true);
  });

  it("keeps the earlier brief and reports a failure, without asking twice while writing", async () => {
    const registry = AtomRegistry.make();
    await requestThreadCatchUp({
      registry,
      threadKey: "env:thread",
      basis: "a",
      generate: async () => ({ ok: true, brief: brief("kept") }),
    });
    let finish: (value: { ok: false; message: string }) => void = () => {};
    const generate = vi.fn(
      () =>
        new Promise<{ ok: false; message: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = requestThreadCatchUp({
      registry,
      threadKey: "env:thread",
      basis: "b",
      generate,
    });
    await requestThreadCatchUp({ registry, threadKey: "env:thread", basis: "b", generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(registry.get(threadCatchUpAtom("env:thread")).loading).toBe(true);

    finish({ ok: false, message: "No model is set up" });
    await pending;
    expect(registry.get(threadCatchUpAtom("env:thread"))).toMatchObject({
      loading: false,
      error: "No model is set up",
      brief: { next: "kept" },
      basis: "a",
    });
  });
});

describe("sinceLastVisitIndex", () => {
  const items = [
    { createdAt: "2026-10-01T12:00:00.000Z" },
    { createdAt: null },
    { createdAt: "2026-10-01T12:10:00.000Z" },
    { createdAt: "2026-10-01T12:20:00.000Z" },
  ];

  it("places the divider before the first item newer than the visit", () => {
    expect(sinceLastVisitIndex(items, "2026-10-01T12:05:00.000Z")).toBe(2);
    expect(sinceLastVisitIndex(items, "2026-10-01T12:10:00.000Z")).toBe(3);
  });

  it("has no divider when nothing is newer or the thread was never visited", () => {
    expect(sinceLastVisitIndex(items, "2026-10-01T12:30:00.000Z")).toBe(-1);
    expect(sinceLastVisitIndex(items, null)).toBe(-1);
    expect(sinceLastVisitIndex(items, undefined)).toBe(-1);
  });
});

describe("isUserAuthoredMessage", () => {
  it("counts the user's own messages, not other agents' or wakes", () => {
    expect(isUserAuthoredMessage({ role: "user", createdBy: "user" })).toBe(true);
    expect(isUserAuthoredMessage({ role: "user" })).toBe(true);
    expect(isUserAuthoredMessage({ role: "user", createdBy: "agent" })).toBe(false);
    expect(isUserAuthoredMessage({ role: "user", createdBy: "system" })).toBe(false);
    expect(isUserAuthoredMessage({ role: "assistant", createdBy: "user" })).toBe(false);
  });
});

describe("nextSinceLastVisitMarker", () => {
  const items = [
    { createdAt: "2026-10-01T12:00:00.000Z" },
    { createdAt: "2026-10-01T12:10:00.000Z" },
  ];
  const open = (
    marker: typeof EMPTY_SINCE_LAST_VISIT_MARKER,
    input: Partial<Parameters<typeof nextSinceLastVisitMarker>[1]> = {},
  ) =>
    nextSinceLastVisitMarker(marker, {
      threadKey: "env:a",
      lastVisitedAt: "2026-10-01T12:05:00.000Z",
      items,
      itemsReady: true,
      ...input,
    });

  it("keeps the visit from opening while the new visit is recorded", () => {
    const opened = open(EMPTY_SINCE_LAST_VISIT_MARKER);
    expect(opened.at).toBe("2026-10-01T12:05:00.000Z");
    // Opening records a visit; the divider stays where it was.
    const visited = open(opened, { lastVisitedAt: "2026-10-01T12:10:00.000Z" });
    expect(visited).toBe(opened);
  });

  it("waits for the shell and the items before placing the divider", () => {
    const noShell = open(EMPTY_SINCE_LAST_VISIT_MARKER, {
      lastVisitedAt: undefined,
      itemsReady: false,
    });
    expect(noShell.at).toBeUndefined();
    const shell = open(noShell, { itemsReady: false });
    expect(shell).toMatchObject({ visitedAt: "2026-10-01T12:05:00.000Z", at: undefined });
    expect(open(shell).at).toBe("2026-10-01T12:05:00.000Z");
  });

  it("has no divider when nothing was new at open, even after the user writes", () => {
    const opened = open(EMPTY_SINCE_LAST_VISIT_MARKER, {
      lastVisitedAt: "2026-10-01T12:30:00.000Z",
    });
    expect(opened.at).toBe(null);
    const afterSending = open(opened, {
      lastVisitedAt: "2026-10-01T12:30:00.000Z",
      items: [...items, { createdAt: "2026-10-01T12:40:00.000Z" }],
    });
    expect(afterSending.at).toBe(null);
  });

  it("takes the visit again when another thread opens", () => {
    const first = open(EMPTY_SINCE_LAST_VISIT_MARKER);
    const second = open(first, { threadKey: "env:b", lastVisitedAt: "2026-10-01T11:00:00.000Z" });
    expect(second).toMatchObject({ threadKey: "env:b", at: "2026-10-01T11:00:00.000Z" });
  });
});
