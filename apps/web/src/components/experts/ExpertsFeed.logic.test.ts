import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadTailMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { mergeExpertTails, selectFeedExperts, threadTailRefreshKey } from "./ExpertsFeed.logic";

const here = EnvironmentId.make("environment-here");
const there = EnvironmentId.make("environment-there");
const pinnedAt = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const now = "2026-10-23T12:00:00.000Z";

function shell(
  environmentId: EnvironmentId,
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
) {
  return presentThreadShell(environmentId, {
    ...makeThreadFixture({ environmentId, id: ThreadId.make(id) }).source,
    pinnedAt,
    ...overrides,
  });
}

const capabilities = { threadSnooze: true, threadSettlement: true };
const serverConfigs = new Map(
  [here, there].map((environmentId) => [environmentId, { environment: { capabilities } }] as const),
) as unknown as Parameters<typeof selectFeedExperts>[0]["serverConfigs"];

describe("selectFeedExperts", () => {
  it("lists the Experts section's threads of every environment", () => {
    const threads = [
      shell(here, "expert"),
      shell(there, "remote-expert"),
      shell(here, "unpinned", { pinnedAt: null }),
      shell(here, "archived", { archivedAt: pinnedAt }),
      shell(here, "settled", { settledOverride: "settled" }),
      shell(here, "snoozed", { snoozedUntil: DateTime.makeUnsafe("2026-10-24T00:00:00.000Z") }),
      shell(here, "woken", { snoozedUntil: DateTime.makeUnsafe("2026-10-22T00:00:00.000Z") }),
    ];
    expect(
      selectFeedExperts({ threads, delegatedUnderParent: new Set(), serverConfigs, now }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["expert", "remote-expert", "woken"]);
  });
});

describe("threadTailRefreshKey", () => {
  it("changes when a run starts or ends or the expert asks, not while it streams", () => {
    const idle = shell(here, "expert", { latestRunId: RunId.make("run-1"), status: "completed" });
    const streaming = shell(here, "expert", {
      latestRunId: RunId.make("run-2"),
      status: "running",
      activeRunId: RunId.make("run-2"),
    });
    const streamedMore = shell(here, "expert", {
      latestRunId: RunId.make("run-2"),
      status: "running",
      activeRunId: RunId.make("run-2"),
      updatedAt: DateTime.makeUnsafe("2026-10-23T12:00:05.000Z"),
      itemCount: 40,
    });
    const done = shell(here, "expert", { latestRunId: RunId.make("run-2"), status: "completed" });
    expect(threadTailRefreshKey(streaming)).not.toBe(threadTailRefreshKey(idle));
    expect(threadTailRefreshKey(streamedMore)).toBe(threadTailRefreshKey(streaming));
    expect(threadTailRefreshKey(done)).not.toBe(threadTailRefreshKey(streaming));
  });
});

function message(id: string, createdAt: string): OrchestrationV2ThreadTailMessage {
  return {
    itemId: TurnItemId.make(id),
    messageId: MessageId.make(id),
    runId: null,
    role: "assistant",
    text: id,
    textTruncated: false,
    streaming: false,
    createdAt,
  };
}

describe("mergeExpertTails", () => {
  it("interleaves the experts' messages by time and marks each expert's newest", () => {
    const first = shell(here, "first");
    const second = shell(there, "second");
    const entries = mergeExpertTails([
      {
        expert: first,
        messages: [message("a1", "2026-10-23T10:00:00.000Z"), message("a2", now)],
      },
      { expert: second, messages: [message("b1", "2026-10-23T11:00:00.000Z")] },
    ]);
    expect(entries.map((entry) => [entry.message.itemId, entry.latest])).toEqual([
      ["a1", false],
      ["b1", true],
      ["a2", true],
    ]);
  });
});
