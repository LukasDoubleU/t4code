import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProjectIconOverride,
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
  openSession: () => Effect.die("No provider turn starts here"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-icon" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.layer(layerTest)("thread icon", (it) => {
  const setup = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:thread-icon"),
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
      const setIcon = (icon: ProjectIconOverride | null) =>
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${threadId}:icon:${(commands += 1)}`),
          threadId,
          icon,
        });
      const shell = () =>
        projections.getThreadShell(threadId).pipe(Effect.map((thread) => thread!));
      return { setIcon, shell };
    });

  it.effect("gives a thread its own icon and takes it back, without moving the thread", () =>
    Effect.gen(function* () {
      const { setIcon, shell } = yield* setup(ThreadId.make("thread:icon-set"));
      const before = yield* shell();
      assert.isNull(before.icon ?? null);

      yield* setIcon({ kind: "lucide", name: "flask-conical", color: "teal" });
      const withIcon = yield* shell();
      assert.deepEqual(withIcon.icon, { kind: "lucide", name: "flask-conical", color: "teal" });
      assert.deepEqual(withIcon.updatedAt, before.updatedAt);

      yield* setIcon(null);
      assert.isNull((yield* shell()).icon);
    }),
  );

  it.effect("rejects a monogram of more than two characters", () =>
    Effect.gen(function* () {
      const { setIcon, shell } = yield* setup(ThreadId.make("thread:icon-monogram"));
      const error = yield* setIcon({ kind: "monogram", text: "ABC", color: "blue" }).pipe(
        Effect.flip,
      );
      assert.include(String(error.cause ?? error.message), "at most two characters");
      yield* setIcon({ kind: "monogram", text: "AB", color: "blue" });
      assert.deepEqual((yield* shell()).icon, { kind: "monogram", text: "AB", color: "blue" });
    }),
  );
});
