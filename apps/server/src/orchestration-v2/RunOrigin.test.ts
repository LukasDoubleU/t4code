import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestrationV2Command,
  type OrchestrationV2NotificationSource,
} from "@t3tools/contracts";
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
    { name: "run-origin" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type MessageOrigin = Pick<
  MessageDispatch,
  "createdBy" | "creationSource" | "scheduledTaskId" | "senderThreadId" | "notification"
>;

const notification = (kind: "background_task" | "monitor") => ({
  source: { kind } as OrchestrationV2NotificationSource,
  outcome: "updated" as const,
  summary: TrimmedNonEmptyString.make("Background activity updated"),
});

it.layer(layerTest)("run origin", (it) => {
  const originsOf = (threadId: ThreadId, messages: ReadonlyArray<MessageOrigin>) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:run-origin"),
        title: "Expert",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const [index, message] of messages.entries()) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text: `Message ${index}`,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          ...message,
        });
      }
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      return runs.toSorted((left, right) => left.ordinal - right.ordinal).map((run) => run.origin);
    });

  it.effect("records who started each run", () =>
    Effect.gen(function* () {
      const origins = yield* originsOf(ThreadId.make("thread:origin-kinds"), [
        { createdBy: "user", creationSource: "web" },
        { createdBy: "agent", creationSource: "mcp", senderThreadId: ThreadId.make("sender") },
        {
          createdBy: "user",
          creationSource: "web",
          scheduledTaskId: ScheduledTaskId.make("task:watch"),
        },
        { createdBy: "agent", creationSource: "server", notification: notification("monitor") },
      ]);
      assert.deepEqual(origins, ["user", "agent", "schedule", "wake"]);
    }),
  );

  it.effect("gives a provider wake the origin of the turn that left its work running", () =>
    Effect.gen(function* () {
      const wake = {
        createdBy: "agent",
        creationSource: "provider",
        notification: notification("background_task"),
      } as const;
      // The wakes queue behind the first run, the latest one that executed, so both continue it.
      const afterUser = yield* originsOf(ThreadId.make("thread:origin-wake-user"), [
        { createdBy: "user", creationSource: "web" },
        wake,
        wake,
      ]);
      assert.deepEqual(afterUser, ["user", "user", "user"]);
      const afterAgent = yield* originsOf(ThreadId.make("thread:origin-wake-agent"), [
        { createdBy: "agent", creationSource: "mcp", senderThreadId: ThreadId.make("sender") },
        wake,
      ]);
      assert.deepEqual(afterAgent, ["agent", "agent"]);
      const alone = yield* originsOf(ThreadId.make("thread:origin-wake-alone"), [wake]);
      assert.deepEqual(alone, ["wake"]);
    }),
  );
});
