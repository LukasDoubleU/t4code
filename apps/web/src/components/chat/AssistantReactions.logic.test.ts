import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  goAheadTarget,
  goAheadText,
  latestReplyItemId,
  reactableReply,
  replyReference,
  replyReferenceLabel,
  thumbsUpAction,
} from "./AssistantReactions.logic";

const threadId = ThreadId.make("thread-reactions");
const NOW = "2026-10-22T12:00:00.000Z";

function reply(
  id: string,
  options: { readonly runId?: string; readonly streaming?: boolean } = {},
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: options.runId === undefined ? null : RunId.make(options.runId),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: options.streaming === true ? "running" : "completed",
    title: null,
    startedAt: DateTime.makeUnsafe(NOW),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(NOW),
    type: "assistant_message",
    messageId: MessageId.make(id),
    text: "Done.",
    streaming: options.streaming === true,
  };
}

function projected(
  item: OrchestrationV2TurnItem,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
): OrchestrationV2ProjectedTurnItem {
  return { position: 0, visibility, sourceThreadId: threadId, sourceItemId: item.id, item };
}

describe("thumbsUpAction", () => {
  it("sets 👍 until the reply has it, then removes it", () => {
    expect(thumbsUpAction(undefined)).toEqual({ reacted: false, label: "React 👍 (no reply)" });
    expect(thumbsUpAction(["👍"])).toEqual({ reacted: true, label: "Remove 👍" });
  });
});

describe("reactableReply", () => {
  it("offers reactions on the thread's own finished replies only", () => {
    expect(reactableReply(projected(reply("item-done")))).toEqual({
      threadId,
      itemId: "item-done",
      repliedAt: NOW,
    });
    expect(reactableReply(projected(reply("item-streaming", { streaming: true })))).toBeNull();
    expect(reactableReply(projected(reply("item-inherited"), "inherited"))).toBeNull();
    expect(reactableReply(undefined)).toBeNull();
  });
});

describe("goAheadTarget", () => {
  it("approves the reply of the latest finished turn", () => {
    const turnItems = [
      reply("item-first", { runId: "run-1" }),
      reply("item-second", { runId: "run-2" }),
      reply("item-running", { runId: "run-3" }),
    ];
    const runs = [
      { id: RunId.make("run-1"), status: "completed" as const },
      { id: RunId.make("run-2"), status: "completed" as const },
      { id: RunId.make("run-3"), status: "running" as const },
    ];

    expect(goAheadTarget({ turnItems, runs }, threadId)?.itemId).toBe("item-second");
    expect(latestReplyItemId(turnItems, threadId)).toBe("item-running");
    expect(goAheadTarget({ turnItems: [], runs }, threadId)).toBeNull();
  });
});

describe("goAheadText", () => {
  it("names a reply that is not the latest by its time", () => {
    const nowMs = Date.parse(NOW);
    expect(goAheadText({ latest: true, repliedAt: NOW, timestampFormat: "24-hour", nowMs })).toBe(
      "👍 Go ahead.",
    );
    expect(
      goAheadText({ latest: false, repliedAt: NOW, timestampFormat: "24-hour", nowMs }),
    ).toMatch(/^👍 Go ahead with your reply from \d{1,2}:\d{2}\.$/);
    expect(
      goAheadText({
        latest: false,
        repliedAt: "2026-10-21T12:00:00.000Z",
        timestampFormat: "24-hour",
        nowMs,
      }),
    ).toMatch(/^👍 Go ahead with your reply from yesterday at \d{1,2}:\d{2}\.$/);
  });
});

describe("replyReference", () => {
  it("names the reply by its footer time and first line, not its text", () => {
    const reference = replyReference(
      { environmentId: EnvironmentId.make("environment-1"), threadId },
      {
        id: MessageId.make("message-plan"),
        text: "\n## Release plan\nTag first, then publish the packages in order.",
        updatedAt: NOW,
      },
    );

    expect(reference).toStrictEqual({
      version: 1,
      environmentId: EnvironmentId.make("environment-1"),
      threadId,
      messageId: MessageId.make("message-plan"),
      repliedAt: NOW,
      excerpt: "## Release plan",
    });
    const nowMs = Date.parse(NOW);
    expect(replyReferenceLabel(reference, "24-hour", nowMs)).toMatch(
      /^Replying to \d{1,2}:\d{2} · ## Release plan$/,
    );
    expect(replyReferenceLabel({ ...reference, excerpt: "" }, "24-hour", nowMs)).toMatch(
      /^Replying to \d{1,2}:\d{2}$/,
    );
  });
});
