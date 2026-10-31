import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs are only queued here; no provider turn starts"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-attention" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

type ThreadCommandInput =
  Extract<
    OrchestrationV2Command,
    {
      readonly type:
        | "thread.metadata.update"
        | "message.dispatch"
        | "message.reaction.set"
        | "thread.settle"
        | "thread.auto-settle";
    }
  > extends infer Command
    ? Command extends OrchestrationV2Command
      ? Omit<Command, "commandId" | "threadId">
      : never
    : never;

it.layer(layerTest)("thread attention", (it) => {
  const setup = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:thread-attention"),
        title: "Expert",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      let commands = 0;
      const dispatch = (command: ThreadCommandInput) =>
        orchestrator.dispatch({
          ...command,
          commandId: CommandId.make(`${threadId}:command:${(commands += 1)}`),
          threadId,
        });
      const mark = (reason: string | null) =>
        dispatch({
          type: "thread.metadata.update",
          attention: reason === null ? null : { reason },
        });
      const message = (from: "user" | "agent") =>
        dispatch({
          type: "message.dispatch",
          messageId: MessageId.make(`${threadId}:message:${commands + 1}`),
          text: "Hello",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          ...(from === "user"
            ? { createdBy: "user", creationSource: "web" }
            : {
                createdBy: "agent",
                creationSource: "mcp",
                senderThreadId: ThreadId.make("other"),
              }),
        });
      const shell = () =>
        projections.getThreadShell(threadId).pipe(Effect.map((thread) => thread!));
      return { dispatch, mark, message, shell };
    });

  it.effect("an agent marks its thread and clears the mark, without moving it", () =>
    Effect.gen(function* () {
      const { mark, shell } = yield* setup(ThreadId.make("thread:attention-mark"));
      const before = yield* shell();
      yield* mark("Pick a release date");
      const marked = yield* shell();
      assert.equal(marked.attention?.reason, "Pick a release date");
      assert.deepEqual(marked.updatedAt, before.updatedAt);
      yield* mark(null);
      assert.isNull((yield* shell()).attention);
    }),
  );

  it.effect("the mark brings a settled thread back and keeps it from settling again", () =>
    Effect.gen(function* () {
      const { dispatch, mark, shell } = yield* setup(ThreadId.make("thread:attention-settled"));
      yield* dispatch({ type: "thread.settle" });
      assert.equal((yield* shell()).settledOverride, "settled");
      yield* mark("Approve the release");
      const marked = yield* shell();
      assert.isNull(marked.settledOverride);
      assert.isNull(marked.settledAt);
      const refused = yield* dispatch({
        type: "thread.auto-settle",
        snapshotAt: marked.updatedAt,
      }).pipe(Effect.flip);
      assert.instanceOf(refused, Orchestrator.OrchestratorDispatchError);
      assert.isNull((yield* shell()).settledOverride);
    }),
  );

  it.effect("the user's message clears the mark; another agent's does not", () =>
    Effect.gen(function* () {
      const { mark, message, shell } = yield* setup(ThreadId.make("thread:attention-message"));
      yield* mark("Approve the migration");
      yield* message("agent");
      assert.equal((yield* shell()).attention?.reason, "Approve the migration");
      yield* message("user");
      assert.isNull((yield* shell()).attention);
    }),
  );

  it.effect("a reaction to a reply clears the mark", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:attention-reaction");
      const { dispatch, mark, shell } = yield* setup(threadId);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const repliedAt = DateTime.makeUnsafe("2026-10-23T08:00:00.000Z");
      const itemId = TurnItemId.make("item:attention-reply");
      yield* projections.apply({
        id: EventId.make("event:attention-reply"),
        type: "turn-item.updated",
        threadId,
        occurredAt: repliedAt,
        payload: {
          id: itemId,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: repliedAt,
          completedAt: repliedAt,
          updatedAt: repliedAt,
          type: "assistant_message",
          messageId: MessageId.make("attention-reply"),
          text: "Should I ship it?",
          streaming: false,
        },
      });
      yield* mark("Ship or hold?");
      yield* dispatch({ type: "message.reaction.set", itemId, emoji: "👍", reacted: true });
      assert.isNull((yield* shell()).attention);
    }),
  );
});
