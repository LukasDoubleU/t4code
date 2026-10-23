import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AccountFailover from "./AccountFailover.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

// The test clock starts at the epoch.
const HOUR = 3_600_000;
const inHours = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(hours * HOUR));
const driver = ProviderDriverKind.make("codex");
const environmentId = EnvironmentId.make("environment:account-failover");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const alternateInstanceId = ProviderInstanceId.make("codex_alternate");

describe("accountMoveNotice", () => {
  it("names both accounts and when the used-up one resets", () => {
    const label = (instanceId: string) => (instanceId === "codex" ? "c2" : "c5");
    const formatTime = (at: number, now: number) => formatResetTimeUtc(at, now);
    assert.equal(
      AccountFailover.accountMoveNotice(
        {
          type: "move",
          from: modelSelection.instanceId,
          to: alternateInstanceId,
          usedUpUntil: HOUR,
        },
        { now: 0, label, formatTime },
      ),
      "Moved from c2 to c5: c2's usage limit is reached until 01:00.",
    );
    assert.equal(
      AccountFailover.accountMoveNotice(
        {
          type: "stay",
          from: modelSelection.instanceId,
          freesUp: { instanceId: alternateInstanceId, at: 50 * HOUR },
        },
        { now: 0, label, formatTime },
      ),
      "No other account is ready. c5 frees up first, at Sat 02:00.",
    );
  });
});

const formatResetTimeUtc = (at: number, now: number) =>
  AccountFailover.formatResetTime(at, now, "UTC");

function usage(sessionUsed: number): ReadonlyArray<ServerProviderUsageWindow> {
  return [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: sessionUsed,
      windowDurationMins: 300,
      resetsAt: inHours(2),
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 10,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: inHours(150),
    },
  ];
}

function snapshot(
  instanceId: ProviderInstanceId,
  displayName: string,
  email: string,
  sessionUsed: number,
): ServerProvider {
  return {
    instanceId,
    driver,
    displayName,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated", email },
    checkedAt: inHours(0),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: inHours(0), windows: usage(sessionUsed) },
  };
}

const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("these tests never start a provider turn"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const instance = (instanceId: ProviderInstanceId) =>
  ({
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: `codex:${instanceId}` },
    displayName: instanceId,
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: { ...orchestrationAdapter, instanceId },
    textGeneration: {} as ProviderInstance["textGeneration"],
  }) satisfies ProviderInstance;
const instances = [instance(modelSelection.instanceId), instance(alternateInstanceId)];

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-account-failover-",
});

/** An orchestrator whose server reads `sessionUsed` percent of the thread's account session. */
const layerRuntime = (sessionUsed: number) =>
  AccountFailover.layerReactor.pipe(
    Layer.provideMerge(
      Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink, ProjectStore.layer),
    ),
    Layer.provide(AccountFailover.layerPolicy),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            snapshot(modelSelection.instanceId, "c2", "two@example.com", sessionUsed),
            snapshot(alternateInstanceId, "c5", "five@example.com", 10),
          ]),
        }),
        Layer.succeed(
          ServerEnvironment.ServerEnvironmentIdentity,
          ServerEnvironment.ServerEnvironmentIdentity.of({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
        ),
      ),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer),
        Layer.provide(VcsProcess.layer),
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatformTest),
      ),
    ),
    Layer.provide(layerServerConfig),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [modelSelection.instanceId]: { driver: "codex", enabled: true },
          [alternateInstanceId]: { driver: "codex", enabled: true },
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          Effect.succeed(instances.find((candidate) => candidate.instanceId === instanceId)),
        listInstances: Effect.succeed(instances),
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
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
    ),
    Layer.provide(layerPlatformTest),
  );

const createThread = Effect.fn("AccountFailoverTest.createThread")(function* (name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threadId = ThreadId.make(`account-failover:${name}`);
  const projectId = ProjectId.make(`account-failover:project:${name}`);
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make(`seed:${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Account failover",
      workspaceRoot: process.cwd(),
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`account-failover:create:${name}`),
    threadId,
    projectId,
    title: "Long-lived thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const sendMessage = (
  threadId: ThreadId,
  key: string,
  dispatchMode: "defer_start" | "queue_after_active" | "start_immediately",
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${threadId}:${key}`),
      threadId,
      messageId: MessageId.make(`${threadId}:${key}`),
      text: key,
      attachments: [],
      dispatchMode: { type: dispatchMode },
      createdBy: "user",
      creationSource: "web",
    }),
  );

/** Ends `run` the way an adapter reports an account's usage limit, and returns that event. */
const failOnUsageLimit = Effect.fn("AccountFailoverTest.failOnUsageLimit")(function* (
  run: OrchestrationV2Run,
) {
  const events = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const failed: OrchestrationV2DomainEvent = {
    id: EventId.make(`${run.id}:failed`),
    type: "run.updated",
    threadId: run.threadId,
    runId: run.id,
    occurredAt: now,
    payload: { ...run, status: "failed", completedAt: now },
  };
  yield* events.write({
    events: [
      {
        id: EventId.make(`${run.id}:limit`),
        type: "turn-item.updated",
        threadId: run.threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`${run.id}:limit`),
          type: "error",
          threadId: run.threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "failed",
          title: "Usage limit reached",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          failure: {
            class: "usage_limit",
            message: "You've hit your usage limit.",
            code: "usageLimitExceeded",
            retryable: null,
            resetAt: inHours(1),
          },
        },
      },
      failed,
    ],
  });
  return failed;
});

const notices = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadRecords(threadId, ["turnItems"], { turnItemTypes: ["system_notice"] }),
  ).pipe(
    Effect.map(({ turnItems }) =>
      turnItems.flatMap((item) =>
        item.type === "system_notice" ? [{ runId: item.runId, message: item.message }] : [],
      ),
    ),
  );

it.layer(layerRuntime(10))("a turn that hits its account's usage limit", (it) => {
  it.effect("continues once on the recommended account, and its queue follows", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const reactor = yield* AccountFailover.AccountFailoverReactor;
      const threadId = yield* createThread("move");
      yield* sendMessage(threadId, "Start work.", "defer_start");
      yield* sendMessage(threadId, "Follow up.", "queue_after_active");
      const [source, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
        OrchestrationV2Run,
        OrchestrationV2Run,
      ];
      yield* reactor.handle(yield* failOnUsageLimit(source));

      const moved = yield* orchestrator.getThreadProjection(threadId);
      const continuation = moved.runs.find((run) => run.id !== source.id && run.id !== queued.id)!;
      assert.equal(continuation.providerInstanceId, alternateInstanceId);
      assert.deepStrictEqual(moved.thread.modelSelection, {
        ...modelSelection,
        instanceId: alternateInstanceId,
      });
      const message = moved.messages.find(
        (candidate) => candidate.id === continuation.userMessageId,
      );
      assert.equal(message?.text, "Continue where you left off.");
      assert.equal(message?.createdBy, "agent");
      assert.deepStrictEqual(yield* notices(threadId), [
        {
          runId: source.id,
          message: `Moved from c2 to c5: c2's usage limit is reached until ${AccountFailover.formatResetTime(HOUR, 0)}.`,
        },
      ]);

      // The message queued for the used-up account starts on the new one, not back on c2.
      const now = yield* DateTime.now;
      yield* events.write({
        events: [
          {
            id: EventId.make(`${continuation.id}:completed`),
            type: "run.updated",
            threadId,
            runId: continuation.id,
            occurredAt: now,
            payload: { ...continuation, status: "completed", completedAt: now },
          },
        ],
      });
      const started = yield* orchestrator
        .streamStoredEventsFrom({ threadId, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.runId === queued.id &&
              stored.event.payload.status !== "queued",
          ),
          Stream.runHead,
        );
      assert.equal(Option.getOrThrow(started).event.providerInstanceId, alternateInstanceId);
    }),
  );

  it.effect("does not move a turn that already continues a move", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* AccountFailover.AccountFailoverReactor;
      const threadId = yield* createThread("once");
      yield* sendMessage(threadId, "Start work.", "defer_start");
      const [source] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
        OrchestrationV2Run,
      ];
      yield* reactor.handle(yield* failOnUsageLimit(source));
      const continuation = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id !== source.id,
      )!;

      yield* reactor.handle(yield* failOnUsageLimit(continuation));

      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(after.runs, 2);
      assert.equal(after.thread.modelSelection.instanceId, alternateInstanceId);
      assert.deepStrictEqual(
        (yield* notices(threadId)).map((notice) => notice.runId),
        [source.id],
      );
    }),
  );

  it.effect("leaves a thread that opted out on its account, until it opts back in", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* AccountFailover.AccountFailoverReactor;
      const threadId = yield* createThread("opt-out");
      const setFailover = (enabled: boolean) =>
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${threadId}:failover:${enabled}`),
          threadId,
          accountFailover: enabled,
        });
      yield* setFailover(false);
      assert.isNotNull((yield* orchestrator.getThreadShell(threadId))?.accountFailoverDisabledAt);
      yield* sendMessage(threadId, "Start work.", "defer_start");
      const [source] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
        OrchestrationV2Run,
      ];

      yield* reactor.handle(yield* failOnUsageLimit(source));

      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(after.runs, 1);
      assert.equal(after.thread.modelSelection.instanceId, modelSelection.instanceId);
      assert.deepStrictEqual(yield* notices(threadId), []);
      yield* setFailover(true);
      assert.isNull((yield* orchestrator.getThreadShell(threadId))?.accountFailoverDisabledAt);
    }),
  );
});

it.layer(layerRuntime(100))("a turn on an account its reading shows used up", (it) => {
  it.effect("starts on the recommended account instead", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* createThread("redirect");

      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${threadId}:hello`),
        threadId,
        messageId: MessageId.make(`${threadId}:hello`),
        text: "Hello",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepStrictEqual(
        projection.runs.map((run) => run.providerInstanceId),
        [alternateInstanceId],
      );
      assert.equal(projection.thread.modelSelection.instanceId, alternateInstanceId);
      assert.deepStrictEqual(yield* notices(threadId), [
        {
          runId: projection.runs[0]!.id,
          message: `Moved from c2 to c5: c2's usage limit is reached until ${AccountFailover.formatResetTime(2 * HOUR, 0)}.`,
        },
      ]);
    }),
  );

  it.effect("stays on its account when the thread opted out", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* createThread("redirect-opt-out");
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${threadId}:failover:false`),
        threadId,
        accountFailover: false,
      });

      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${threadId}:hello`),
        threadId,
        messageId: MessageId.make(`${threadId}:hello`),
        text: "Hello",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepStrictEqual(
        projection.runs.map((run) => run.providerInstanceId),
        [modelSelection.instanceId],
      );
      assert.deepStrictEqual(yield* notices(threadId), []);
    }),
  );
});
