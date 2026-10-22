import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const projectId = ProjectId.make("project:mcp-wait-wake");
const waiter = ThreadId.make("thread:mcp-wait-wake-waiter");
const answerer = ThreadId.make("thread:mcp-wait-wake-answerer");
const driver = ProviderDriverKind.make("codex");
const steering = ProviderInstanceId.make("codex");
/** Takes no active steer: a steer would restart its turn. */
const queueOnly = ProviderInstanceId.make("codex-queue-only");
const model = "gpt-5.4";
const answer = "Use the second approach.\n\nThe first one breaks the mobile build.";

const scopeOf = (threadId: ThreadId, instanceId = steering): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:mcp-wait-wake"),
  requestNamespace: `provider-session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session:${threadId}`,
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

interface Provider {
  /** A thread's turn ends once its gate opens; other turns keep running. */
  readonly ends: Map<ThreadId, Deferred.Deferred<void>>;
  readonly starts: Queue.Queue<ThreadId>;
  readonly steers: Queue.Queue<{ readonly threadId: ThreadId; readonly text: string }>;
}

const makeAdapter = (
  instanceId: ProviderInstanceId,
  capabilities: OrchestrationV2ProviderCapabilities,
  provider: Provider,
): ProviderAdapter.ProviderAdapterV2["Service"] => {
  const unused = (detail: string) =>
    Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const openedAt = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities,
          createdAt: openedAt,
          updatedAt: openedAt,
          lastError: null,
        };
        const publish = (published: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
          Effect.forEach(published, (event) => PubSub.publish(events, event), { discard: true });
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              const startedAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const providerTurn = (
                status: OrchestrationV2ProviderTurn["status"],
              ): OrchestrationV2ProviderTurn => ({
                id: providerTurnId,
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                  strength: "strong",
                },
                ordinal: turnInput.providerTurnOrdinal,
                status,
                startedAt,
                completedAt: status === "running" ? null : startedAt,
              });
              yield* publish([
                { type: "provider_turn.updated", driver, providerTurn: providerTurn("running") },
              ]);
              yield* Queue.offer(provider.starts, turnInput.threadId);
              const end = provider.ends.get(turnInput.threadId);
              if (end === undefined) return;
              yield* Deferred.await(end).pipe(
                Effect.andThen(
                  publish([
                    {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: providerTurn("completed"),
                    },
                    {
                      type: "turn.terminal",
                      driver,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId,
                      runOrdinal: turnInput.runOrdinal,
                      status: "completed",
                      failure: null,
                      threadDisposition: "reusable",
                    },
                  ]),
                ),
                Effect.forkDetach,
              );
            }),
          steerTurn: (steer) =>
            Queue.offer(provider.steers, {
              threadId: steer.threadId,
              text: steer.message.text,
            }).pipe(Effect.asVoid),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unused("readThreadSnapshot is unused in this test"),
          rollbackThread: () => unused("rollbackThread is unused in this test"),
          forkThread: () => unused("forkThread is unused in this test"),
        };
      }),
  };
};

/**
 * A live orchestrator with both instances, the waiting and the answering
 * thread with their turns running, and a signal for when a wait starts
 * watching the waiting thread's messages.
 */
const withThreads = <A, E>(
  body: (context: {
    readonly service: OrchestratorMcpService.OrchestratorMcpService["Service"];
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly provider: Provider;
    readonly watching: Deferred.Deferred<void>;
  }) => Effect.Effect<A, E, never>,
  options: { readonly waiterInstance?: ProviderInstanceId } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("mcp-wait-wake");
      const provider: Provider = {
        ends: new Map([[answerer, yield* Deferred.make<void>()]]),
        starts: yield* Queue.unbounded<ThreadId>(),
        steers: yield* Queue.unbounded<{ readonly threadId: ThreadId; readonly text: string }>(),
      };
      const watching = yield* Deferred.make<void>();
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
        makeAdapter(steering, CodexProviderCapabilitiesV2, provider),
        makeAdapter(
          queueOnly,
          {
            ...CodexProviderCapabilitiesV2,
            turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: false },
          },
          provider,
        ),
      ]);
      const layerDatabase = SqlitePersistence.layerMemory;
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "mcp-wait-wake", runtimePolicyOverride: { cwd } },
        layerRegistry,
        { databaseLayer: layerDatabase },
      );
      // What the thread service sees: the same orchestrator, telling the
      // test when a wait starts watching the waiting thread's messages.
      const layerWatchedOrchestrator = Layer.effect(
        Orchestrator.OrchestratorV2,
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          return Orchestrator.OrchestratorV2.of({
            ...orchestrator,
            streamStoredEventsFrom: (input) =>
              input?.eventType === "message.updated" && input.threadId === waiter
                ? Stream.fromEffect(Deferred.succeed(watching, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(orchestrator.streamStoredEventsFrom(input)),
                  )
                : orchestrator.streamStoredEventsFrom(input),
          });
        }),
      ).pipe(Layer.provide(layerOrchestrator));
      const layerSettings = ServerSettings.layerTest({
        providerInstances: {
          [steering]: { driver: "codex", enabled: true },
          [queueOnly]: { driver: "codex", enabled: true },
        },
      });
      const layerThreads = ThreadManagementService.layer.pipe(
        Layer.provide(layerWatchedOrchestrator),
        Layer.provideMerge(layerOrchestrator),
        Layer.provide(
          LegacyV1ThreadImporter.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(layerDatabase),
          ),
        ),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
        Layer.provideMerge(layerSettings),
      );
      const layerTest = OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provideMerge(layerThreads),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerRegistry,
            layerSettings,
            ProviderRegistryMock.layer([]),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const start = Effect.fn("waitWake.start")(function* (
          threadId: ThreadId,
          title: string,
          instanceId: ProviderInstanceId,
        ) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId,
            title,
            modelSelection: { instanceId, model },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:start`),
            threadId,
            messageId: MessageId.make(`${threadId}:start`),
            text: `Start ${title}.`,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          yield* Queue.take(provider.starts);
          // Its turn is steerable once the running provider turn is projected.
          yield* orchestrator
            .streamStoredEventsFrom({ threadId, eventType: "provider-turn.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
            );
        });
        yield* start(waiter, "Waiting agent", options.waiterInstance ?? steering);
        yield* start(answerer, "Answering agent", steering);
        return yield* body({ service, orchestrator, provider, watching });
      }).pipe(Effect.provide(layerTest));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

const queuedRuns = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.filter((run) => run.status === "queued");

describe("t3_thread_wait wakes on a message for the waiting thread", () => {
  it.live("ends when another thread answers and steers the answer into the waiting turn", () =>
    withThreads(({ service, orchestrator, provider, watching }) =>
      Effect.gen(function* () {
        const waiting = yield* service
          .waitForThread(scopeOf(waiter), { threadId: answerer, timeoutMs: 600_000 })
          .pipe(Effect.forkChild);
        yield* Deferred.await(watching);
        const sent = yield* service.sendToThread(scopeOf(answerer), {
          threadId: waiter,
          message: answer,
          mode: "queue",
        });
        expect(sent.delivery).toBe("queued");

        const waited = yield* Fiber.join(waiting);
        expect(waited).toMatchObject({
          threadId: answerer,
          status: "running",
          timedOut: false,
          messageReceived: {
            messageId: sent.messageId,
            createdBy: "agent",
            senderThreadId: answerer,
            senderTitle: "Answering agent",
            preview: "Use the second approach. The first one breaks the mobile build.",
            delivery: "steered",
          },
        });
        // The waiting turn gets the whole message as a steer...
        expect(yield* Queue.take(provider.steers)).toEqual({ threadId: waiter, text: answer });
        // ...and no queued copy is left to start a turn later.
        const projection = yield* orchestrator.getThreadProjection(waiter);
        expect(queuedRuns(projection)).toEqual([]);
        expect(projection.runs.find((run) => run.id === sent.runId)?.status).toBe("cancelled");
        const running = projection.runs.find((run) => run.status === "running");
        expect(projection.messages.find((message) => message.id === sent.messageId)?.runId).toBe(
          running?.id,
        );
      }),
    ),
  );

  it.live("ends on a message from the user", () =>
    withThreads(({ service, orchestrator, provider, watching }) =>
      Effect.gen(function* () {
        const waiting = yield* service
          .waitForThread(scopeOf(waiter), { threadId: answerer, timeoutMs: 600_000 })
          .pipe(Effect.forkChild);
        yield* Deferred.await(watching);
        const messageId = MessageId.make("message:mcp-wait-wake:user");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:mcp-wait-wake:user"),
          threadId: waiter,
          messageId,
          text: "Stop waiting, I answered it myself.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });

        const waited = yield* Fiber.join(waiting);
        expect(waited.messageReceived).toEqual({
          messageId,
          createdBy: "user",
          preview: "Stop waiting, I answered it myself.",
          delivery: "steered",
        });
        expect(yield* Queue.take(provider.steers)).toEqual({
          threadId: waiter,
          text: "Stop waiting, I answered it myself.",
        });
        expect(queuedRuns(yield* orchestrator.getThreadProjection(waiter))).toEqual([]);
      }),
    ),
  );

  it.live("ends but keeps the message queued when the waiting turn takes no steer", () =>
    withThreads(
      ({ service, orchestrator, watching }) =>
        Effect.gen(function* () {
          const waiting = yield* service
            .waitForThread(scopeOf(waiter, queueOnly), { threadId: answerer, timeoutMs: 600_000 })
            .pipe(Effect.forkChild);
          yield* Deferred.await(watching);
          const sent = yield* service.sendToThread(scopeOf(answerer), {
            threadId: waiter,
            message: answer,
            mode: "queue",
          });

          const waited = yield* Fiber.join(waiting);
          expect(waited.messageReceived).toMatchObject({
            messageId: sent.messageId,
            delivery: "queued",
          });
          // The turn is neither restarted nor steered: the message starts the next one.
          const projection = yield* orchestrator.getThreadProjection(waiter);
          expect(queuedRuns(projection).map((run) => run.id)).toEqual([sent.runId]);
          expect(projection.runs.filter((run) => run.status === "running")).toHaveLength(1);
        }),
      { waiterInstance: queueOnly },
    ),
  );

  it.live("without a message, ends as before when the run settles or the wait times out", () =>
    withThreads(({ service, orchestrator, provider }) =>
      Effect.gen(function* () {
        const timedOut = yield* service.waitForThread(scopeOf(waiter), {
          threadId: answerer,
          timeoutMs: 1,
        });
        expect(timedOut).toMatchObject({ threadId: answerer, status: "running", timedOut: true });
        expect(timedOut.messageReceived).toBeUndefined();

        const waiting = yield* service
          .waitForThread(scopeOf(waiter), { threadId: answerer, timeoutMs: 600_000 })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(provider.ends.get(answerer)!, undefined);
        const settled = yield* Fiber.join(waiting);
        expect(settled).toMatchObject({ threadId: answerer, status: "completed", timedOut: false });
        expect(settled.messageReceived).toBeUndefined();
        expect(queuedRuns(yield* orchestrator.getThreadProjection(waiter))).toEqual([]);
      }),
    ),
  );
});
