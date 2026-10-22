import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type AssistantPassage,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2MessageReaction,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import type { AssistantReplyItem } from "./messageReactions.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { providerMessageText } from "./providerMessageText.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:reactions");
const at = (time: string) => DateTime.makeUnsafe(`2026-10-22T${time}.000Z`);

const replyItem = (input: {
  readonly threadId: ThreadId;
  readonly id: string;
  readonly text: string;
  readonly repliedAt: DateTime.Utc;
  readonly ordinal: number;
  readonly streaming?: boolean;
}): AssistantReplyItem => ({
  id: TurnItemId.make(`item:${input.id}`),
  threadId: input.threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: input.ordinal,
  status: input.streaming === true ? "running" : "completed",
  title: null,
  startedAt: input.repliedAt,
  completedAt: input.streaming === true ? null : input.repliedAt,
  updatedAt: input.repliedAt,
  type: "assistant_message",
  messageId: MessageId.make(input.id),
  text: input.text,
  streaming: input.streaming === true,
});

const itemEvent = (payload: OrchestrationV2TurnItem, key = "item"): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${payload.id}:${key}`),
  type: "turn-item.updated",
  threadId: payload.threadId,
  occurredAt: payload.updatedAt,
  payload,
});

const adapter = {
  instanceId: providerInstanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Reactions never start a provider turn"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "message-reactions" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId,
      title: "Reactions",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("sets and clears a reaction on a reply without starting a turn", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:reactions-set");
    yield* createThread(threadId);
    const repliedAt = at("13:20:00");
    const answer = replyItem({
      threadId,
      id: "reply:set",
      text: "Ship it.",
      repliedAt,
      ordinal: 1,
    });
    yield* projections.apply(itemEvent(answer));
    const react = (id: string, reacted: boolean, goAhead?: boolean) =>
      orchestrator.dispatch({
        type: "message.reaction.set",
        commandId: CommandId.make(id),
        threadId,
        itemId: answer.id,
        emoji: "👍",
        reacted,
        ...(goAhead === undefined ? {} : { goAhead }),
      });
    const stored = () =>
      Effect.gen(function* () {
        const item = yield* projections.getTurnItem({ threadId, itemId: answer.id });
        const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
        assert.equal(item?.type, "assistant_message");
        return { reply: item as AssistantReplyItem, runs };
      });

    yield* react("reactions-set-thumbs-up", true);
    const reacted = yield* stored();
    const [thumbsUp] = reacted.reply.reactions ?? [];
    assert.equal(reacted.reply.reactions?.length, 1);
    assert.equal(thumbsUp?.emoji, "👍");
    assert.isUndefined(thumbsUp?.goAhead);
    assert.deepEqual(reacted.reply.updatedAt, repliedAt);
    assert.deepEqual(reacted.runs, []);

    // Setting it again changes nothing; Go ahead then takes it over.
    yield* react("reactions-set-again", true);
    assert.deepEqual((yield* stored()).reply.reactions, reacted.reply.reactions);
    yield* react("reactions-set-go-ahead", true, true);
    assert.isTrue((yield* stored()).reply.reactions?.[0]?.goAhead);

    yield* react("reactions-set-clear", false);
    const cleared = yield* stored();
    assert.isUndefined(cleared.reply.reactions);
    assert.deepEqual(cleared.runs, []);
  }).pipe(Effect.provide(layerOrchestrator)),
);

it.effect("rejects a reaction on anything but a finished assistant reply", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:reactions-reject");
    yield* createThread(threadId);
    const streaming = replyItem({
      threadId,
      id: "reply:streaming",
      text: "Thinking",
      repliedAt: at("13:20:00"),
      ordinal: 1,
      streaming: true,
    });
    const { messageId: _messageId, ...reasoningFields } = replyItem({
      threadId,
      id: "reasoning",
      text: "Weighing it",
      repliedAt: at("13:19:00"),
      ordinal: 2,
    });
    const reasoning: OrchestrationV2TurnItem = { ...reasoningFields, type: "reasoning" };
    yield* projections.apply(itemEvent(streaming));
    yield* projections.apply(itemEvent(reasoning));
    for (const itemId of [streaming.id, reasoning.id, TurnItemId.make("item:missing")]) {
      const error = yield* orchestrator
        .dispatch({
          type: "message.reaction.set",
          commandId: CommandId.make(`reactions-reject-${itemId}`),
          threadId,
          itemId,
          emoji: "👍",
          reacted: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
    }
  }).pipe(Effect.provide(layerOrchestrator)),
);

const storageCases = (["sqlite", "memory"] as const).map((storage) => ({
  storage,
  storeLayer:
    storage === "sqlite"
      ? ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))
      : ProjectionStore.layerMemory,
}));

/**
 * One thread whose runs start, take steers and get reactions at chosen times. Each delivery
 * returns what the provider receives for its message, as both send paths compute it.
 */
const makeDeliveryThread = Effect.fn("makeDeliveryThread")(function* (name: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  const createdAt = at("12:00:00");
  yield* store.apply({
    id: EventId.make(`event:${name}:thread`),
    type: "thread.created",
    threadId,
    occurredAt: createdAt,
    payload: {
      id: threadId,
      projectId,
      title: "Reactions",
      providerInstanceId,
      modelSelection,
      createdBy: "user",
      creationSource: "web",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  let runOrdinal = 0;
  let itemOrdinal = 0;
  const userMessage = (
    id: string,
    text: string,
    runId: RunId,
    createdAt: DateTime.Utc,
  ): OrchestrationV2ConversationMessage => ({
    id: MessageId.make(id),
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt,
    updatedAt: createdAt,
  });
  const applyMessage = (payload: OrchestrationV2ConversationMessage) =>
    store.apply({
      id: EventId.make(`event:${payload.id}`),
      type: "message.updated",
      threadId,
      occurredAt: payload.createdAt,
      payload,
    });
  return {
    reply: (id: string, text: string, repliedAt: DateTime.Utc) =>
      Effect.gen(function* () {
        itemOrdinal += 1;
        const item = replyItem({ threadId, id, text, repliedAt, ordinal: itemOrdinal });
        yield* store.apply(itemEvent(item));
        return item.id;
      }),
    react: (itemId: TurnItemId, reactions: ReadonlyArray<OrchestrationV2MessageReaction>) =>
      Effect.gen(function* () {
        const { reactions: _previous, ...reply } = (yield* store.getTurnItem({
          threadId,
          itemId,
        })) as AssistantReplyItem;
        const key = reactions.map((reaction) => DateTime.formatIso(reaction.reactedAt)).join();
        yield* store.apply(
          itemEvent(reactions.length === 0 ? reply : { ...reply, reactions }, `react:${key}`),
        );
      }),
    /** Starts a run for a new user message and returns what its provider turn receives. */
    startRun: (id: string, text: string, startedAt: DateTime.Utc) =>
      Effect.gen(function* () {
        runOrdinal += 1;
        const runId = RunId.make(`run:${id}`);
        const message = userMessage(id, text, runId, startedAt);
        yield* applyMessage(message);
        yield* store.apply({
          id: EventId.make(`event:${id}:run`),
          type: "run.created",
          threadId,
          runId,
          occurredAt: startedAt,
          payload: {
            id: runId,
            threadId,
            ordinal: runOrdinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: message.id,
            rootNodeId: NodeId.make(`node:${id}`),
            activeAttemptId: null,
            status: "running",
            requestedAt: startedAt,
            startedAt,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        return { runId, text: yield* providerMessageText(store, message, startedAt) };
      }),
    /** Steers a message into `runId` and returns what the provider receives for it. */
    steer: (runId: RunId, id: string, text: string, steeredAt: DateTime.Utc) =>
      Effect.gen(function* () {
        const message = userMessage(id, text, runId, steeredAt);
        yield* applyMessage(message);
        return yield* providerMessageText(store, message, steeredAt);
      }),
  };
});

const thumbsUp = (reactedAt: DateTime.Utc, goAhead?: true) => ({
  emoji: "👍" as const,
  reactedAt,
  ...(goAhead === undefined ? {} : { goAhead }),
});

it.effect.each(storageCases)(
  "$storage: tells the next turn about a reaction once",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const thread = yield* makeDeliveryThread("reactions-once");
      yield* thread.startRun("message:first", "Plan the release.", at("13:00:00"));
      const answer = yield* thread.reply(
        "reply:plan",
        "\n# Release plan\nTag first, then publish the packages in order.",
        at("13:20:10"),
      );
      yield* thread.react(answer, [thumbsUp(at("13:25:00"))]);

      const next = yield* thread.startRun("message:second", "Start with the tag.", at("13:30:00"));
      assert.equal(
        next.text,
        [
          'The user reacted 👍 to your reply from 2026-10-22 13:20 UTC ("# Release plan").',
          "",
          "Start with the tag.",
        ].join("\n"),
      );
      const later = yield* thread.startRun("message:third", "Now publish.", at("13:40:00"));
      assert.equal(later.text, "Now publish.");
    }).pipe(Effect.provide(storeLayer)),
);

it.effect.each(storageCases)(
  "$storage: a reaction cleared before the turn and a Go ahead reaction are not told",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const thread = yield* makeDeliveryThread("reactions-not-told");
      yield* thread.startRun("message:first", "Two options?", at("13:00:00"));
      const cleared = yield* thread.reply("reply:cleared", "Option A.", at("13:10:00"));
      const approved = yield* thread.reply(
        "reply:approved",
        "I would refactor the store first, keeping its interface stable for every caller.",
        at("13:11:00"),
      );
      yield* thread.react(cleared, [thumbsUp(at("13:12:00"))]);
      yield* thread.react(cleared, []);
      yield* thread.react(approved, [thumbsUp(at("13:14:00"), true)]);

      const goAhead = yield* thread.startRun("message:go-ahead", "👍 Go ahead.", at("13:15:00"));
      assert.equal(goAhead.text, "👍 Go ahead.");
    }).pipe(Effect.provide(storeLayer)),
);

it.effect.each(storageCases)(
  "$storage: a steer tells the reactions since the turn started, and the next turn skips them",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const thread = yield* makeDeliveryThread("reactions-steer");
      const first = yield* thread.startRun("message:first", "Fix the bug.", at("13:00:00"));
      const answer = yield* thread.reply(
        "reply:cause",
        "The cache key ignores the locale, which is a long line that goes on past sixty characters.",
        at("13:05:00"),
      );
      yield* thread.react(answer, [thumbsUp(at("13:06:00"))]);

      const steered = yield* thread.steer(
        first.runId,
        "message:steer",
        "Also add a test.",
        at("13:07:00"),
      );
      assert.equal(
        steered,
        [
          'The user reacted 👍 to your reply from 2026-10-22 13:05 UTC ("The cache key ignores the locale, which is a long line that…").',
          "",
          "Also add a test.",
        ].join("\n"),
      );
      const next = yield* thread.startRun("message:next", "Thanks.", at("13:30:00"));
      assert.equal(next.text, "Thanks.");
    }).pipe(Effect.provide(storeLayer)),
);

/** `text` as it sits in `reply`, the way the selection toolbar captures it. */
const passageOf = (reply: string, text: string): AssistantPassage => {
  const start = reply.indexOf(text);
  return { text, start, end: start + text.length, prefix: "", suffix: "" };
};

it.effect("sets and clears reactions on passages, one per passage, without starting a turn", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:reactions-passage");
    yield* createThread(threadId);
    const text = "Option A: patch it. Option B: rewrite the parser.";
    const answer = replyItem({
      threadId,
      id: "reply:passage",
      text,
      repliedAt: at("13:20:00"),
      ordinal: 1,
    });
    yield* projections.apply(itemEvent(answer));
    const optionA = passageOf(text, "Option A: patch it.");
    const optionB = passageOf(text, "Option B: rewrite the parser.");
    const react = (
      id: string,
      emoji: "👍" | "👎",
      reacted: boolean,
      passage: AssistantPassage | undefined,
    ) =>
      orchestrator.dispatch({
        type: "message.reaction.set",
        commandId: CommandId.make(`reactions-passage-${id}`),
        threadId,
        itemId: answer.id,
        emoji,
        reacted,
        ...(passage === undefined ? {} : { passage }),
      });
    const stored = Effect.gen(function* () {
      const item = (yield* projections.getTurnItem({
        threadId,
        itemId: answer.id,
      })) as AssistantReplyItem;
      return (item.reactions ?? []).map((reaction) => [reaction.emoji, reaction.passage?.text]);
    });

    yield* react("whole", "👍", true, undefined);
    yield* react("b-up", "👍", true, optionB);
    yield* react("a-down", "👎", true, optionA);
    assert.deepEqual(yield* stored, [
      ["👍", undefined],
      ["👍", optionB.text],
      ["👎", optionA.text],
    ]);

    // 👎 on B replaces its 👍; the whole reply and A keep theirs.
    yield* react("b-down", "👎", true, optionB);
    assert.deepEqual(yield* stored, [
      ["👍", undefined],
      ["👎", optionA.text],
      ["👎", optionB.text],
    ]);

    yield* react("whole-clear", "👍", false, undefined);
    yield* react("a-clear", "👎", false, optionA);
    assert.deepEqual(yield* stored, [["👎", optionB.text]]);
    assert.deepEqual((yield* projections.getThreadRecords(threadId, ["runs"])).runs, []);
  }).pipe(Effect.provide(layerOrchestrator)),
);

it.effect("rejects 👎 without a passage, and 👎 as a Go ahead", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:reactions-thumbs-down");
    yield* createThread(threadId);
    const answer = replyItem({
      threadId,
      id: "reply:thumbs-down",
      text: "Drop the cache.",
      repliedAt: at("13:20:00"),
      ordinal: 1,
    });
    yield* projections.apply(itemEvent(answer));
    for (const [id, extra] of [
      ["whole", {}],
      ["go-ahead", { passage: passageOf(answer.text, "Drop"), goAhead: true }],
    ] as const) {
      const error = yield* orchestrator
        .dispatch({
          type: "message.reaction.set",
          commandId: CommandId.make(`reactions-thumbs-down-${id}`),
          threadId,
          itemId: answer.id,
          emoji: "👎",
          reacted: true,
          ...extra,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
    }
    const item = yield* projections.getTurnItem({ threadId, itemId: answer.id });
    assert.isUndefined((item as AssistantReplyItem).reactions);
  }).pipe(Effect.provide(layerOrchestrator)),
);

it.effect.each(storageCases)(
  "$storage: tells the next turn about a passage reaction once, quoting the passage",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const thread = yield* makeDeliveryThread("reactions-passage-once");
      yield* thread.startRun("message:first", "How do we fix the parser?", at("13:00:00"));
      const text = "Two ways:\n\nOption A: patch it.\nOption B: rewrite\nthe parser.";
      const answer = yield* thread.reply("reply:options", text, at("13:20:10"));
      yield* thread.react(answer, [
        thumbsUp(at("13:25:00")),
        { emoji: "👎", reactedAt: at("13:26:00"), passage: passageOf(text, "Option A: patch it.") },
        {
          emoji: "👍",
          reactedAt: at("13:27:00"),
          passage: passageOf(text, "Option B: rewrite\nthe parser."),
        },
      ]);

      const next = yield* thread.startRun("message:second", "Go with B.", at("13:30:00"));
      assert.equal(
        next.text,
        [
          'The user reacted 👍 to your reply from 2026-10-22 13:20 UTC ("Two ways:").',
          "",
          "The user reacted 👎 to this passage of your reply from 2026-10-22 13:20 UTC:",
          "> Option A: patch it.",
          "",
          "The user reacted 👍 to this passage of your reply from 2026-10-22 13:20 UTC:",
          "> Option B: rewrite",
          "> the parser.",
          "",
          "Go with B.",
        ].join("\n"),
      );
      const later = yield* thread.startRun("message:third", "Now test it.", at("13:40:00"));
      assert.equal(later.text, "Now test it.");
    }).pipe(Effect.provide(storeLayer)),
);

it.effect.each(storageCases)(
  "$storage: Go ahead on a passage reaches the agent as its citation, not again as a note",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const thread = yield* makeDeliveryThread("reactions-passage-go-ahead");
      yield* thread.startRun("message:first", "Which option?", at("13:00:00"));
      const text = "Option A: patch it. Option B: rewrite the parser.";
      const answer = yield* thread.reply("reply:go-ahead", text, at("13:20:10"));
      const passage = passageOf(text, "Option B: rewrite the parser.");
      yield* thread.react(answer, [
        { emoji: "👍", reactedAt: at("13:25:00"), goAhead: true, passage },
      ]);

      const goAhead = yield* thread.startRun(
        "message:go-ahead",
        serializeAssistantCitation({
          version: 1,
          environmentId: EnvironmentId.make("environment:reactions"),
          threadId: ThreadId.make("thread:reactions-passage-go-ahead"),
          messageId: MessageId.make("reply:go-ahead"),
          ...passage,
          comment: "👍 Go ahead.",
        }),
        at("13:25:00"),
      );
      assert.match(goAhead.text, /^Quoted from an earlier assistant reply\b/);
      assert.include(goAhead.text, "> Option B: rewrite the parser.\n\nUser comment: 👍 Go ahead.");
      assert.notInclude(goAhead.text, "The user reacted");
    }).pipe(Effect.provide(storeLayer)),
);
