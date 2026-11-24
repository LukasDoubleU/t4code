import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

import { idleCompactionWindow, type IdleCompactionRecords } from "./IdleCompaction.ts";

const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const threadId = ThreadId.make("idle-thread");
const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

function records(
  usage: {
    readonly usedTokens?: number;
    readonly maxTokens?: number;
    readonly autoCompactThreshold?: number;
    readonly cacheExpiresInMs?: number;
  } = {},
): { -readonly [Key in keyof IdleCompactionRecords]: IdleCompactionRecords[Key] } {
  const messageId = MessageId.make("message-1");
  const nodeId = NodeId.make("root-node");
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-MINUTE_MS),
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Explain this code",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-MINUTE_MS),
        updatedAt: at(-MINUTE_MS),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-MINUTE_MS),
        updatedAt: at(),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("provider-turn-1"),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        tokenUsage: {
          usedTokens: usage.usedTokens ?? 250_000,
          ...(usage.maxTokens === undefined ? {} : { maxTokens: usage.maxTokens }),
          ...(usage.autoCompactThreshold === undefined
            ? {}
            : { autoCompactThreshold: usage.autoCompactThreshold }),
          ...(usage.cacheExpiresInMs === undefined
            ? {}
            : { promptCacheExpiresAt: DateTime.formatIso(at(usage.cacheExpiresInMs)) }),
          updatedAt: DateTime.formatIso(at()),
        },
      },
    ],
    runtimeRequests: [],
    turnItems: [],
    contextTransfers: [],
  };
}

describe("idleCompactionWindow", () => {
  it("skips small contexts, unknown expiry, other providers, switched threads, compactions, and side chats", () => {
    const cache = { cacheExpiresInMs: 60 * MINUTE_MS };
    expect(
      idleCompactionWindow(
        records({ ...cache, usedTokens: 199_999 }),
        NOW_MS,
        "beforeCacheExpires",
      ),
    ).toBeNull();
    expect(idleCompactionWindow(records(), NOW_MS, "beforeCacheExpires")).toBeNull();
    const codex = records(cache);
    codex.providerThreads = [
      { ...codex.providerThreads[0]!, driver: ProviderDriverKind.make("codex") },
    ];
    expect(idleCompactionWindow(codex, NOW_MS, "beforeCacheExpires")).toBeNull();
    const switched = records(cache);
    switched.thread = { ...switched.thread, providerInstanceId: ProviderInstanceId.make("codex") };
    expect(idleCompactionWindow(switched, NOW_MS, "beforeCacheExpires")).toBeNull();
    const compacted = records(cache);
    compacted.messages = [{ ...compacted.messages[0]!, text: "/compact" }];
    expect(idleCompactionWindow(compacted, NOW_MS, "beforeCacheExpires")).toBeNull();
    const steered = records(cache);
    steered.runs = [
      ...steered.runs,
      {
        ...steered.runs[0]!,
        id: RunId.make("run-2"),
        ordinal: 2,
        userMessageId: MessageId.make("message-2"),
        status: "cancelled",
        startedAt: null,
      },
    ];
    expect(idleCompactionWindow(steered, NOW_MS, "beforeCacheExpires")?.runId).toBe(runId);
    // A turn Claude itself reported as cancelled did run, so it stays the latest.
    steered.runs = steered.runs.map((run) => ({ ...run, startedAt: at(-MINUTE_MS) }));
    expect(idleCompactionWindow(steered, NOW_MS, "beforeCacheExpires")).toBeNull();
    const archived = records(cache);
    archived.thread = { ...archived.thread, archivedAt: at() };
    expect(idleCompactionWindow(archived, NOW_MS, "beforeCacheExpires")).toBeNull();
    const sideChat = records(cache);
    expect(idleCompactionWindow(sideChat, NOW_MS, "beforeCacheExpires")).not.toBeNull();
    sideChat.thread = {
      ...sideChat.thread,
      lineage: { ...sideChat.thread.lineage, relationshipToParent: "fork", sideChat: true },
    };
    expect(idleCompactionWindow(sideChat, NOW_MS, "beforeCacheExpires")).toBeNull();
  });

  it.each([
    // 90 % of the 1M window: a minute after the turn, in either mode.
    { mode: "onReturn", usage: { usedTokens: 900_000 }, start: MINUTE_MS },
    { mode: "beforeCacheExpires", usage: { usedTokens: 900_000 }, start: MINUTE_MS },
    { mode: "off", usage: { usedTokens: 900_000 }, start: null },
    // A lower compaction threshold counts, even below the size cache-expiry compaction needs.
    {
      mode: "onReturn",
      usage: { usedTokens: 106_000, autoCompactThreshold: 117_000 },
      start: MINUTE_MS,
    },
    // Not near the limit: each mode as before.
    { mode: "onReturn", usage: { usedTokens: 899_999 }, start: null },
    { mode: "beforeCacheExpires", usage: { usedTokens: 899_999 }, start: 58 * MINUTE_MS },
    // Held back near the limit: each mode as if it were not.
    {
      mode: "beforeCacheExpires",
      usage: { usedTokens: 900_000 },
      compactNearLimit: false,
      start: 58 * MINUTE_MS,
    },
    { mode: "onReturn", usage: { usedTokens: 900_000 }, compactNearLimit: false, start: null },
  ] as const)(
    "compacts a thread near the limit soon after its turn: $mode/$usage.usedTokens/$compactNearLimit",
    ({ mode, usage, start, ...test }) => {
      const window = idleCompactionWindow(
        records({ maxTokens: 1_000_000, cacheExpiresInMs: 60 * MINUTE_MS, ...usage }),
        NOW_MS,
        mode,
        { compactNearLimit: "compactNearLimit" in test ? test.compactNearLimit : true },
      );
      expect(window === null ? null : window.startMs - NOW_MS).toBe(start);
      if (window !== null)
        expect(window.reason).toBe(start === MINUTE_MS ? "nearLimit" : "beforeCacheExpires");
    },
  );

  it.each([
    // The cache expired an hour after the turn; the server checks at `idle` after the turn.
    { idle: 61 * MINUTE_MS, reason: "missedSlot" },
    { idle: 24 * 60 * MINUTE_MS, reason: "missedSlot" },
    { idle: 24 * 60 * MINUTE_MS + 1, reason: null },
    { idle: 61 * MINUTE_MS, makeUp: false, reason: null },
    // Within the slot nothing was missed.
    { idle: 59 * MINUTE_MS, reason: "beforeCacheExpires" },
    { idle: 61 * MINUTE_MS, mode: "onReturn", reason: null },
    { idle: 61 * MINUTE_MS, mode: "off", reason: null },
    { idle: 61 * MINUTE_MS, usedTokens: 199_999, reason: null },
    { idle: 61 * MINUTE_MS, change: "compacted", reason: null },
    { idle: 61 * MINUTE_MS, change: "snoozed", reason: null },
    { idle: 61 * MINUTE_MS, change: "settled", reason: null },
    { idle: 61 * MINUTE_MS, change: "archived", reason: null },
    { idle: 61 * MINUTE_MS, change: "running", reason: null },
  ] as const)(
    "makes up a slot the server missed: $idle/$mode/$makeUp/$usedTokens/$change",
    ({ idle, reason, ...test }) => {
      const data = records({
        cacheExpiresInMs: 60 * MINUTE_MS,
        ...("usedTokens" in test ? { usedTokens: test.usedTokens } : {}),
      });
      const change = "change" in test ? test.change : undefined;
      if (change === "compacted") data.messages = [{ ...data.messages[0]!, text: "/compact" }];
      if (change === "snoozed")
        data.thread = { ...data.thread, snoozedUntil: at(idle + 60 * MINUTE_MS) };
      if (change === "settled") data.thread = { ...data.thread, settledAt: at(MINUTE_MS) };
      if (change === "archived") data.thread = { ...data.thread, archivedAt: at(MINUTE_MS) };
      // The user sent at wake: their turn is running.
      if (change === "running")
        data.runs = [
          ...data.runs,
          { ...data.runs[0]!, id: RunId.make("run-2"), ordinal: 2, status: "running" },
        ];
      const window = idleCompactionWindow(
        data,
        NOW_MS + idle,
        "mode" in test ? test.mode : "beforeCacheExpires",
        { makeUp: "makeUp" in test ? test.makeUp : true },
      );
      expect(window?.reason ?? null).toBe(reason);
      if (window !== null) expect(window.startMs).toBe(NOW_MS + 58 * MINUTE_MS);
    },
  );
});

describe("IdleCompactionService", () => {
  it.effect.each([
    { mode: "onReturn", reads: 1, dispatches: 0 },
    { mode: "off", reads: 0, dispatches: 0 },
    { mode: "beforeCacheExpires", reads: 1, dispatches: 1 },
    { mode: "beforeCacheExpires", override: "off", reads: 0, dispatches: 0 },
    { mode: "onReturn", override: "beforeCacheExpires", reads: 1, dispatches: 1 },
    { mode: "beforeCacheExpires", projectDisabled: true, reads: 0, dispatches: 0 },
    { mode: "beforeCacheExpires", enabled: false, reads: 0, dispatches: 0 },
    { mode: "beforeCacheExpires", driver: "codex", instance: "codex", reads: 0, dispatches: 0 },
    {
      mode: "beforeCacheExpires",
      driver: "codex",
      instance: "custom-codex",
      reads: 0,
      dispatches: 0,
    },
    {
      mode: "beforeCacheExpires",
      driver: "claudeAgent",
      instance: "custom-claude",
      reads: 1,
      dispatches: 1,
    },
    { mode: "beforeCacheExpires", unconfigured: true, reads: 1, dispatches: 1 },
    { mode: "onReturn", nearLimit: true, reads: 1, dispatches: 1 },
    { mode: "off", nearLimit: true, reads: 0, dispatches: 0 },
    // Its memory reminder is due: the user's next turn carries it, not the compaction.
    { mode: "onReturn", nearLimit: true, pinned: true, reads: 2, dispatches: 0 },
    { mode: "onReturn", nearLimit: true, pinned: true, reminded: true, reads: 2, dispatches: 1 },
    { mode: "onReturn", nearLimit: true, pinned: true, memory: false, reads: 1, dispatches: 1 },
  ] as const)(
    "compacts only eligible idle threads: $mode/$override/$enabled/$projectDisabled/$instance/$unconfigured/$nearLimit/$pinned/$reminded/$memory",
    (scenario) => {
      const test = {
        override: "default",
        enabled: true,
        projectDisabled: false,
        nearLimit: false,
        pinned: false,
        reminded: false,
        memory: true,
        ...scenario,
      } as const;
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const selectedInstance = ProviderInstanceId.make(
          "instance" in test ? test.instance : "claudeAgent",
        );
        const driver = ProviderDriverKind.make("driver" in test ? test.driver : "claudeAgent");
        const base = records({
          cacheExpiresInMs: 2 * MINUTE_MS,
          ...(test.nearLimit ? { maxTokens: 1_000_000, usedTokens: 950_000 } : {}),
        });
        const latestTurn = base.providerTurns[0]!;
        const data: OrchestrationV2ThreadProjection = {
          ...base,
          thread: {
            ...base.thread,
            providerInstanceId: selectedInstance,
            modelSelection: { ...base.thread.modelSelection, instanceId: selectedInstance },
            ...(test.pinned ? { pinnedAt: at(-MINUTE_MS) } : {}),
          },
          // A minute ago, so a compaction near the limit is due now.
          runs: base.runs.map((run) => ({
            ...run,
            providerInstanceId: selectedInstance,
            modelSelection: { ...run.modelSelection, instanceId: selectedInstance },
            completedAt: at(-MINUTE_MS),
          })),
          providerTurns: test.reminded
            ? [
                {
                  ...latestTurn,
                  id: ProviderTurnId.make("provider-turn-0"),
                  ordinal: 0,
                  tokenUsage: {
                    ...latestTurn.tokenUsage!,
                    usedTokens: 900_000,
                    updatedAt: DateTime.formatIso(at(-2 * MINUTE_MS)),
                  },
                },
                latestTurn,
              ]
            : base.providerTurns,
          providerThreads: base.providerThreads.map((thread) => ({
            ...thread,
            driver,
            providerInstanceId: selectedInstance,
          })),
          attempts: [],
          nodes: [],
          subagents: [],
          providerSessions: [],
          plans: [],
          checkpointScopes: [],
          checkpoints: [],
          contextHandoffs: [],
          visibleTurnItems: [],
          updatedAt: at(),
        };
        let historyReads = 0;
        let dispatches = 0;
        const done = yield* Deferred.make<void>();
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (...args) => {
              end(...args);
              if (span.name === "IdleCompactionService.compactWhenDue")
                Deferred.doneUnsafe(done, Effect.void);
            };
            return span;
          },
        });
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.make({
              id: EventId.make("idle-completed"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: at(),
              payload: data.runs[0]!,
            }),
            dispatch: () =>
              Effect.sync(() => {
                dispatches++;
                return { sequence: 1, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed(data.thread),
            getIdleCompactionCandidates: () => Effect.succeed([]),
            getThreadRecords: () =>
              Effect.sync(() => {
                historyReads++;
                return data;
              }),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              idleCompaction: test.mode,
              pinnedThreadsKeepMemory: test.memory,
              providerInstances:
                "unconfigured" in test
                  ? {}
                  : {
                      [selectedInstance]: {
                        driver,
                        enabled: test.enabled,
                        config: { idleCompaction: test.override },
                      },
                    },
              projectSettingsOverrides: test.projectDisabled
                ? {
                    [data.thread.projectId]: {
                      providerInstances: { [selectedInstance]: { enabled: false } },
                    },
                  }
                : {},
            }),
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* IdleCompactionService.make;
          yield* service.start();
          yield* Deferred.await(done);
        }).pipe(Effect.provide(dependencies), Effect.withTracer(tracer));
        expect(historyReads).toBe(test.reads);
        expect(dispatches).toBe(test.dispatches);
      });
    },
  );

  it.effect("keeps the latest run's compaction when an earlier run reports completed again", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const base = records({ cacheExpiresInMs: 10 * MINUTE_MS });
      const laterRunId = RunId.make("run-2");
      const laterMessageId = MessageId.make("message-2");
      const earlierRun = base.runs[0]!;
      const laterRun = {
        ...earlierRun,
        id: laterRunId,
        ordinal: 2,
        userMessageId: laterMessageId,
      };
      const cancelledRun = {
        ...earlierRun,
        id: RunId.make("run-3"),
        ordinal: 3,
        userMessageId: MessageId.make("message-3"),
        status: "cancelled" as const,
        startedAt: null,
      };
      const data: OrchestrationV2ThreadProjection = {
        ...base,
        runs: [earlierRun, laterRun, cancelledRun],
        messages: [
          ...base.messages,
          { ...base.messages[0]!, id: laterMessageId, runId: laterRunId, text: "Keep going" },
        ],
        providerThreads: [{ ...base.providerThreads[0]!, lastRunOrdinal: 2 }],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [],
        plans: [],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        visibleTurnItems: [],
        updatedAt: at(),
      };
      const completed = (run: typeof earlierRun) => ({
        id: EventId.make(`completed-${run.id}`),
        type: "run.updated" as const,
        threadId,
        runId: run.id,
        occurredAt: at(),
        payload: run,
      });
      const dispatched: Array<string> = [];
      const streamDone = yield* Deferred.make<void>();
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          // A delegated completion on the earlier run lands after the later run completed.
          streamDomainEvents: Stream.make(completed(laterRun), completed(earlierRun)).pipe(
            Stream.ensuring(Deferred.succeed(streamDone, undefined)),
          ),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.commandId);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed(data.thread),
          getIdleCompactionCandidates: () => Effect.succeed([]),
          getThreadRecords: (_threadId, _keys, options) =>
            Effect.succeed({
              ...data,
              messages: data.messages.filter(
                (message) =>
                  options?.messageRunIds === undefined ||
                  (message.runId !== null && options.messageRunIds.includes(message.runId)),
              ),
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            idleCompaction: "beforeCacheExpires",
          }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* IdleCompactionService.make;
        yield* service.start();
        yield* Deferred.await(streamDone);
        yield* TestClock.adjust(9 * MINUTE_MS);
      }).pipe(Effect.provide(dependencies));
      expect(dispatched).toEqual(["server:idle-compact:idle-thread:run-2"]);
    }),
  );

  const HOUR_MS = 60 * MINUTE_MS;
  // The turn ended at NOW_MS and its cache expires an hour later.
  const idleThread = (id: ThreadId): OrchestrationV2ThreadProjection => {
    const base = records({ cacheExpiresInMs: HOUR_MS });
    return {
      ...base,
      thread: { ...base.thread, id, lineage: { ...base.thread.lineage, rootThreadId: id } },
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      plans: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      visibleTurnItems: [],
      updatedAt: at(),
    };
  };
  const runUpdated = (
    thread: OrchestrationV2ThreadProjection,
    run: OrchestrationV2ThreadProjection["runs"][number],
  ): OrchestrationV2DomainEvent => ({
    id: EventId.make(`updated-${thread.thread.id}-${run.id}`),
    type: "run.updated",
    threadId: thread.thread.id,
    runId: run.id,
    occurredAt: at(),
    payload: run,
  });
  const compactionEnded = (thread: OrchestrationV2ThreadProjection) =>
    runUpdated(thread, {
      ...thread.runs[0]!,
      id: RunId.make("compaction-run"),
      ordinal: 2,
      userMessageId: MessageId.make(`idle-compact:${thread.thread.id}:${runId}`),
      // Not "completed", which would replace the waiting fiber anyway.
      status: "failed",
    });

  /** The service over `threads`, with a wall clock that runs `clock.skewMs` ahead of its timers. */
  const makeUpHarness = Effect.fn(function* (options: {
    readonly threads: Map<ThreadId, OrchestrationV2ThreadProjection>;
    readonly candidates: ReadonlyArray<ThreadId>;
    readonly onDispatch?: (threadId: ThreadId) => void;
  }) {
    const testClock = yield* TestClock.testClockWith(Effect.succeed);
    const clock = { skewMs: 0 };
    const wallClock: Clock.Clock = {
      ...testClock,
      currentTimeMillisUnsafe: () => testClock.currentTimeMillisUnsafe() + clock.skewMs,
      currentTimeMillis: Effect.sync(() => testClock.currentTimeMillisUnsafe() + clock.skewMs),
    };
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const dispatched = yield* Queue.unbounded<ThreadId>();
    const reads = yield* Queue.unbounded<ThreadId>();
    const finished = yield* Queue.unbounded<void>();
    const tracer = Tracer.make({
      span(spanOptions) {
        const span = new Tracer.NativeSpan(spanOptions);
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          if (span.name === "IdleCompactionService.compactWhenDue")
            Queue.offerUnsafe(finished, undefined);
        };
        return span;
      },
    });
    const thread = (id: ThreadId) => options.threads.get(id)!;
    const dependencies = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromQueue(events),
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type === "message.dispatch") {
              expect(command.idleCompaction).toBe("beforeCacheExpires");
              options.onDispatch?.(command.threadId);
              Queue.offerUnsafe(dispatched, command.threadId);
            }
            return { sequence: 1, storedEvents: [] };
          }),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: (id) => Effect.sync(() => thread(id).thread),
        getIdleCompactionCandidates: () =>
          Effect.succeed(options.candidates.map((id) => ({ threadId: id, runId }))),
        getThreadRecords: (id) =>
          Effect.sync(() => {
            Queue.offerUnsafe(reads, id);
            return thread(id);
          }),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          idleCompaction: "beforeCacheExpires",
        }),
      }),
    );
    const start = Effect.gen(function* () {
      const service = yield* IdleCompactionService.make;
      yield* service.start();
    }).pipe(
      Effect.provide(dependencies),
      Effect.provideService(Clock.Clock, wallClock),
      Effect.withTracer(tracer),
    );
    return { start, testClock, clock, events, dispatched, reads, finished };
  });

  it.effect.each([
    // Timers stall while the machine sleeps; the wall clock jumps by the sleep.
    { via: "sleep", slept: 11 * HOUR_MS, wait: MINUTE_MS, dispatches: 1 },
    { via: "sleep", slept: 25 * HOUR_MS, wait: MINUTE_MS, dispatches: 0 },
    // A server that restarts half an hour after the turn keeps the slot.
    { via: "restart", slept: 0, wait: 28 * MINUTE_MS, dispatches: 1 },
  ] as const)(
    "compacts when a sleep or restart cut its timer short: $via/$slept",
    ({ via, slept, wait, dispatches }) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(via === "restart" ? NOW_MS + 30 * MINUTE_MS : NOW_MS);
        const data = idleThread(threadId);
        const harness = yield* makeUpHarness({
          threads: new Map([[threadId, data]]),
          candidates: via === "restart" ? [threadId] : [],
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* harness.start;
            if (via === "sleep")
              yield* Queue.offer(harness.events, runUpdated(data, data.runs[0]!));
            yield* Queue.take(harness.reads);
            harness.clock.skewMs = slept;
            yield* harness.testClock.adjust(wait);
            if (dispatches === 1) {
              expect(yield* Queue.take(harness.dispatched)).toBe(threadId);
            } else {
              yield* Queue.take(harness.finished);
              expect(yield* Queue.size(harness.dispatched)).toBe(0);
            }
          }),
        );
      }),
  );

  it.effect.each([{ userSends: false }, { userSends: true }])(
    "makes up slots missed while stopped one thread at a time: userSends $userSends",
    ({ userSends }) =>
      Effect.gen(function* () {
        // Started three hours after the turns, two hours after their caches expired.
        yield* TestClock.setTime(NOW_MS + 3 * HOUR_MS);
        const ids = [ThreadId.make("idle-a"), ThreadId.make("idle-b")];
        const threads = new Map(ids.map((id) => [id, idleThread(id)]));
        const log: Array<string> = [];
        const harness = yield* makeUpHarness({
          threads,
          candidates: ids,
          onDispatch: (dispatchedId) => {
            log.push("dispatch");
            // The user sends to the other thread while its make-up waits its turn.
            if (!userSends) return;
            const other = ids.find((id) => id !== dispatchedId)!;
            const data = threads.get(other)!;
            threads.set(other, {
              ...data,
              runs: [
                ...data.runs,
                { ...data.runs[0]!, id: RunId.make("run-2"), ordinal: 2, status: "running" },
              ],
            });
          },
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* harness.start;
            const first = yield* Queue.take(harness.dispatched);
            log.push("ended");
            yield* Queue.offer(harness.events, compactionEnded(threads.get(first)!));
            if (!userSends) {
              const second = yield* Queue.take(harness.dispatched);
              expect(second).not.toBe(first);
              yield* Queue.offer(harness.events, compactionEnded(threads.get(second)!));
            }
            yield* Queue.take(harness.finished);
            yield* Queue.take(harness.finished);
          }),
        );
        expect(log).toEqual(userSends ? ["dispatch", "ended"] : ["dispatch", "ended", "dispatch"]);
      }),
  );
});
