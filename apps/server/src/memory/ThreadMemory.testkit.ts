import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ThreadMemory from "./ThreadMemory.ts";

// Memory tests run a real orchestrator over an in-memory database; the T3
// home is a fresh temporary directory, never the real one.

export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const projectId = ProjectId.make("project:experts");

const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("memory tests start no provider sessions"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerPlatform = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-experts-" });

const layerRuntime = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerServerConfig),
      Layer.provide(layerPlatform),
    ),
  ),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provide(layerPlatform),
);

/** A runtime with thread memory on, for layers built on both. */
export const layerWithRuntime = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(
    Layer.provideMerge(layerRuntime),
    Layer.provideMerge(ThreadMemory.layer),
    Layer.provideMerge(ServerSettings.layerTest({ pinnedThreadsKeepMemory: true })),
    Layer.provideMerge(layerServerConfig),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );

export const seedProject = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make(`seed:${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: "2026-10-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Experts",
      workspaceRoot: "/workspace/experts",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  }),
);

/** A thread in the seeded project, pinned at `orderKey` unless that is null. */
export const createThread = Effect.fn("ThreadMemoryTestkit.createThread")(function* (
  name: string,
  orderKey: string | null,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId,
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
  });
  if (orderKey !== null) {
    yield* orchestrator.dispatch({
      type: "thread.pin",
      commandId: CommandId.make(`pin:${name}`),
      threadId,
      orderKey,
    });
  }
  return threadId;
});
