import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as RunExecutionService from "../orchestration-v2/RunExecutionService.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadMemory from "./ThreadMemory.ts";

const layerTest = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layerEmpty,
      Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
      Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
        allocate: () => Effect.succeed(1),
      }),
      Layer.mock(EventSink.EventSinkV2)({}),
      IdAllocator.layer,
      Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
        ingestNormalized: () => Effect.succeed([]),
      }),
    ),
  ),
  // As in the server, the memory comes from the surrounding context.
  Layer.provideMerge(ThreadMemory.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-memory-run-" })),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

const startTurnOf = (
  appThread: OrchestrationV2AppThread,
  nativeForkSource?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["nativeForkSource"],
  contextNearlyFull?: boolean,
) =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const started = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2TurnInput>();
    const providerInstanceId = ProviderInstanceId.make("claudeAgent");
    const attemptId = RunAttemptId.make(`attempt:${appThread.id}`);
    const session = {
      events: Stream.never,
      startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        Deferred.succeed(started, input),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    yield* runExecution.startRootRun({
      commandId: CommandId.make(`command:${appThread.id}`),
      appThread,
      providerSessionId: ProviderSessionId.make(`session:${appThread.id}`),
      session,
      run: {
        id: RunId.make(`run:${appThread.id}`),
        threadId: appThread.id,
        ordinal: 1,
        providerInstanceId,
      } as OrchestrationV2Run,
      rootNode: { id: NodeId.make(`node:${appThread.id}`) } as OrchestrationV2ExecutionNode,
      checkpointScope: {
        id: CheckpointScopeId.make(`checkpoint-scope:${appThread.id}`),
      } as OrchestrationV2CheckpointScope,
      providerThread: {
        id: ProviderThreadId.make(`provider-thread:${appThread.id}`),
        driver: ProviderDriverKind.make("claudeAgent"),
      } as OrchestrationV2ProviderThread,
      attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
      attemptId,
      providerTurnOrdinal: 1,
      ...(nativeForkSource === undefined ? {} : { nativeForkSource }),
      ...(contextNearlyFull === undefined ? {} : { contextNearlyFull }),
      message: {
        messageId: MessageId.make(`message:${appThread.id}`),
        text: "Carry on.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: process.cwd() },
    });
    return yield* Deferred.await(started);
  });

const ownLineage = (id: ThreadId): OrchestrationV2AppThread["lineage"] => ({
  parentThreadId: null,
  relationshipToParent: null,
  rootThreadId: id,
});

it.effect("hands a pinned thread's memory to its provider turn, and none to an unpinned one", () =>
  Effect.gen(function* () {
    const memory = yield* ThreadMemory.ThreadMemory;
    const pinnedId = ThreadId.make("thread:pinned");
    const pinned = yield* startTurnOf({
      id: pinnedId,
      pinnedAt: yield* DateTime.now,
      lineage: ownLineage(pinnedId),
    } as OrchestrationV2AppThread);
    assert.deepEqual(
      pinned.threadMemory,
      yield* memory.forTurn({
        id: pinnedId,
        pinnedAt: yield* DateTime.now,
        lineage: ownLineage(pinnedId),
      }),
    );
    assert.isDefined(pinned.threadMemory);

    const unpinnedId = ThreadId.make("thread:unpinned");
    const unpinned = yield* startTurnOf({
      id: unpinnedId,
      pinnedAt: null,
      lineage: ownLineage(unpinnedId),
    } as OrchestrationV2AppThread);
    assert.isUndefined(unpinned.threadMemory);

    // A delegated task created by an older build carries its pinned parent's pinnedAt.
    const delegated = yield* startTurnOf({
      id: ThreadId.make("thread:delegated"),
      pinnedAt: yield* DateTime.now,
      lineage: {
        parentThreadId: pinnedId,
        relationshipToParent: "subagent",
        rootThreadId: pinnedId,
      },
    } as OrchestrationV2AppThread);
    assert.isUndefined(delegated.threadMemory);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("hands a native fork of a pinned thread the note about its source's memory", () =>
  Effect.gen(function* () {
    const memory = yield* ThreadMemory.ThreadMemory;
    const sourceId = ThreadId.make("thread:pinned-source");
    const forkId = ThreadId.make("thread:fork");
    const fork = {
      id: forkId,
      pinnedAt: null,
      lineage: { parentThreadId: sourceId, relationshipToParent: "fork", rootThreadId: sourceId },
    } as OrchestrationV2AppThread;

    const first = yield* startTurnOf(fork, { id: sourceId, pinned: true });
    assert.equal(first.forkedMemoryNote, yield* memory.forkNote({ id: sourceId, pinned: true }));
    assert.isDefined(first.forkedMemoryNote);
    assert.isUndefined(first.threadMemory);

    // Later runs of the fork no longer consume the native fork.
    const later = yield* startTurnOf({ ...fork, id: ThreadId.make("thread:fork-later") });
    assert.isUndefined(later.forkedMemoryNote);

    const quietSource = yield* startTurnOf(
      { ...fork, id: ThreadId.make("thread:fork-of-unpinned") },
      { id: ThreadId.make("thread:never-pinned"), pinned: false },
    );
    assert.isUndefined(quietSource.forkedMemoryNote);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("tells a pinned thread near a full context to save its memory, and no other", () =>
  Effect.gen(function* () {
    const pinnedId = ThreadId.make("thread:pinned-near-full");
    const pinned = yield* startTurnOf(
      {
        id: pinnedId,
        pinnedAt: yield* DateTime.now,
        lineage: ownLineage(pinnedId),
      } as OrchestrationV2AppThread,
      undefined,
      true,
    );
    assert.isDefined(pinned.threadMemory);
    assert.equal(
      pinned.memoryReminder,
      ThreadMemory.threadMemoryNudge(pinned.threadMemory?.path ?? ""),
    );

    const unpinnedId = ThreadId.make("thread:unpinned-near-full");
    const unpinned = yield* startTurnOf(
      {
        id: unpinnedId,
        pinnedAt: null,
        lineage: ownLineage(unpinnedId),
      } as OrchestrationV2AppThread,
      undefined,
      true,
    );
    assert.isUndefined(unpinned.memoryReminder);

    const roomyId = ThreadId.make("thread:pinned-roomy");
    const roomy = yield* startTurnOf({
      id: roomyId,
      pinnedAt: yield* DateTime.now,
      lineage: ownLineage(roomyId),
    } as OrchestrationV2AppThread);
    assert.isUndefined(roomy.memoryReminder);
  }).pipe(Effect.provide(layerTest)),
);
