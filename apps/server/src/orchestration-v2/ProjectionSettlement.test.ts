import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RunOrigin,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isAutoSettlementCandidate, resolveAutoSettlementAt } from "./ThreadSettlementService.ts";

const layerSql = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
const old = DateTime.subtract(now, { days: 10 });
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:settlement:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:settlement"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: old,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"] = "completed",
  ordinal = 1,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* store.apply({
    id: EventId.make(`event:${runId}`),
    type: "run.created",
    threadId,
    occurredAt: old,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: old,
      startedAt: status === "queued" ? null : old,
      completedAt: ["completed", "rolled_back", "failed"].includes(status) ? old : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  return runId;
});

const createItem = Effect.fn(function* (
  threadId: ThreadId,
  runId: RunId,
  status: "idle" | "running" | "completed",
  persistent = false,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`event:item:${runId}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: old,
    payload: {
      id: TurnItemId.make(`item:${runId}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "dynamic_tool",
      status,
      title: null,
      startedAt: old,
      completedAt: status === "completed" ? old : null,
      updatedAt: old,
      toolName: "background",
      input: persistent ? { persistent: true } : null,
      output: null,
    },
  });
});

it.effect(
  "sql: discovers settlement work with the same activity and background semantics as the shell",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const idle = yield* createThread("idle");
      const completed = yield* createThread("completed");
      yield* createRun(completed);
      for (const [name, overrides] of [
        ["archived", { archivedAt: old }],
        ["deleted", { deletedAt: old }],
        ["settled", { settledOverride: "settled" }],
        ["unsettled", { settledOverride: "active" }],
        ["pinned", { pinnedAt: old }],
        ["auto-settle-disabled", { autoSettleDisabledAt: old }],
      ] satisfies ReadonlyArray<readonly [string, Partial<OrchestrationV2AppThread>]>) {
        yield* createRun(yield* createThread(name, overrides));
      }
      for (const status of ["preparing", "starting", "running", "waiting"] as const) {
        yield* createRun(yield* createThread(status), status);
      }
      const queued = yield* createThread("queued");
      yield* createRun(queued, "queued");
      const blocked = yield* createThread("blocked");
      yield* store.apply({
        id: EventId.make("event:settlement:request"),
        type: "runtime-request.updated",
        threadId: blocked,
        occurredAt: old,
        payload: {
          id: RuntimeRequestId.make("request:settlement"),
          nodeId: NodeId.make("node:settlement"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "not_resumable", reason: "Process stopped" },
          createdAt: old,
          resolvedAt: null,
        },
      });
      const recent = yield* createThread("recent-message");
      yield* createRun(recent);
      yield* store.apply({
        id: EventId.make("event:settlement:message"),
        type: "message.updated",
        threadId: recent,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make("message:settlement:recent"),
          threadId: recent,
          runId: null,
          nodeId: null,
          role: "user",
          text: "Next turn",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* createRun(
        yield* createThread("snoozed", {
          snoozedUntil: DateTime.add(now, { days: 1 }),
          snoozedAt: now,
        }),
      );
      const woke = yield* createThread("woke", {
        snoozedUntil: DateTime.add(now, { days: 1 }),
        snoozedAt: DateTime.subtract(old, { days: 1 }),
      });
      yield* createRun(woke, "failed");
      const background = yield* createThread("idle-background");
      yield* createItem(background, yield* createRun(background), "idle");
      const persistent = yield* createThread("persistent-monitor");
      yield* createItem(persistent, yield* createRun(persistent), "running", true);
      const rolledBack = yield* createThread("rolled-back-background");
      yield* createItem(rolledBack, yield* createRun(rolledBack, "rolled_back"), "running");
      yield* createRun(rolledBack, "completed", 2);
      const roster = yield* createThread("provider-roster");
      yield* createRun(roster);
      yield* store.apply({
        id: EventId.make("event:settlement:roster"),
        type: "provider-thread.updated",
        threadId: roster,
        occurredAt: old,
        payload: {
          id: ProviderThreadId.make("provider-thread:settlement"),
          appThreadId: roster,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: old,
          updatedAt: old,
          pendingBackgroundTasks: [{ taskId: "running-task", kind: "subagent" }],
        },
      });
      const candidates = yield* store.getSettlementCandidates();
      const shell = yield* store.getShellSnapshot({ location: "active" });
      const eligible = candidates.filter((thread) =>
        isAutoSettlementCandidate(thread, DateTime.toEpochMillis(now)),
      );
      assert.deepEqual(
        new Set(eligible.map((thread) => thread.id)),
        new Set([idle, completed, queued, woke, background, persistent, rolledBack]),
      );
      assert.deepEqual(
        new Set(eligible.map((thread) => thread.id)),
        new Set(
          shell.threads
            .filter((thread) => isAutoSettlementCandidate(thread, DateTime.toEpochMillis(now)))
            .map((thread) => thread.id),
        ),
      );
      for (const candidate of candidates) {
        const expected = shell.threads.find((thread) => thread.id === candidate.id)!;
        assert.deepEqual(candidate.pendingBackgroundTasks, expected.pendingBackgroundTasks);
        const settings = {
          pullRequest: null,
          nowMs: DateTime.toEpochMillis(now),
          autoSettleAfterDays: 7,
          autoSettleOnMerge: false,
        };
        assert.deepEqual(
          resolveAutoSettlementAt({ ...settings, thread: candidate }),
          resolveAutoSettlementAt({
            ...settings,
            thread: {
              ...expected,
              latestUserOrThreadMessageAt: candidate.latestUserOrThreadMessageAt,
            },
          }),
        );
      }
      assert.equal(
        DateTime.formatIso((yield* store.getThread(completed)).createdAt),
        DateTime.formatIso(old),
      );
      assert.equal(
        (yield* store.getThread(ThreadId.make("missing")).pipe(Effect.flip))._tag,
        "ProjectionStoreThreadNotFoundError",
      );
    }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: settlement anchors on the user's and other threads' messages, not deliveries", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* createThread("agent-woken");
    yield* createRun(threadId);
    const message = (
      id: string,
      at: DateTime.Utc,
      sender: Pick<OrchestrationV2ConversationMessage, "createdBy" | "creationSource"> &
        Partial<OrchestrationV2ConversationMessage>,
    ) =>
      store.apply({
        id: EventId.make(`event:settlement:${id}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          ...sender,
          id: MessageId.make(`message:settlement:${id}`),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: id,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      });
    const minutesAgo = (minutes: number) => DateTime.subtract(now, { minutes });
    const written = minutesAgo(120);
    const sent = minutesAgo(60);
    const other = ThreadId.make("thread:settlement:sender");
    yield* message("written", written, { createdBy: "user", creationSource: "web" });
    yield* message("sent", sent, {
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: other,
    });
    yield* message("watch-wake", minutesAgo(40), {
      createdBy: "agent",
      creationSource: "server",
      notification: { source: { kind: "system" }, outcome: "updated", summary: "Checks passed" },
    });
    yield* message("delegated-completion", minutesAgo(30), {
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: other,
      delegatedCompletion: {
        parentRunId: RunId.make("run:settlement:parent"),
        generation: 1,
        taskIds: [NodeId.make("node:settlement:task")],
      },
    });
    // A scheduled run carries its task's creator.
    yield* message("scheduled", minutesAgo(20), {
      createdBy: "user",
      creationSource: "web",
      scheduledTaskId: ScheduledTaskId.make("scheduled:settlement"),
    });
    yield* message("notification", now, { createdBy: "agent", creationSource: "provider" });

    const [candidate] = yield* store.getSettlementCandidates(threadId);
    assert.isDefined(candidate);
    assert.equal(DateTime.formatIso(candidate.latestUserMessageAt!), DateTime.formatIso(now));
    assert.equal(
      DateTime.formatIso(candidate.latestUserOrThreadMessageAt!),
      DateTime.formatIso(sent),
    );
  }).pipe(Effect.provide(layerSql)),
);

it.effect.each([["sql", layerSql]] as const)(
  "%s: the shell says who started the latest run and keeps the user's result behind it",
  ([, testLayer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const userAt = DateTime.add(old, { minutes: 1 });
      const backgroundAt = DateTime.add(old, { minutes: 2 });
      const run = Effect.fn(function* (
        threadId: ThreadId,
        ordinal: number,
        origin: OrchestrationV2RunOrigin | undefined,
        completedAt: DateTime.Utc,
      ) {
        const runId = RunId.make(`run:${threadId}:${ordinal}`);
        yield* store.apply({
          id: EventId.make(`event:${runId}`),
          type: "run.created",
          threadId,
          occurredAt: completedAt,
          payload: {
            id: runId,
            threadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:${runId}`),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: old,
            startedAt: old,
            completedAt,
            checkpointId: null,
            contextHandoffId: null,
            ...(origin === undefined ? {} : { origin }),
          },
        });
      });
      const legacy = yield* createThread("origin-legacy");
      yield* run(legacy, 1, undefined, userAt);
      const own = yield* createThread("origin-own");
      yield* run(own, 1, "agent", userAt);
      yield* run(own, 2, "user", backgroundAt);
      const behind = yield* createThread("origin-behind");
      yield* run(behind, 1, "user", userAt);
      yield* run(behind, 2, "schedule", backgroundAt);
      const alone = yield* createThread("origin-alone");
      yield* run(alone, 1, "wake", backgroundAt);
      const marked = yield* createThread("origin-marked", {
        attention: { reason: "Pick a release date", requestedAt: userAt },
      });

      const shell = yield* store.getShellSnapshot();
      const row = (threadId: ThreadId) => {
        const thread = shell.threads.find((candidate) => candidate.id === threadId);
        return {
          origin: thread?.latestRunOrigin,
          userRunCompletedAt:
            thread?.latestUserRunCompletedAt == null
              ? null
              : DateTime.formatIso(thread.latestUserRunCompletedAt),
          attention: thread?.attention?.reason ?? null,
        };
      };
      assert.deepEqual(row(legacy), {
        origin: undefined,
        userRunCompletedAt: null,
        attention: null,
      });
      assert.deepEqual(row(own), { origin: "user", userRunCompletedAt: null, attention: null });
      assert.deepEqual(row(behind), {
        origin: "schedule",
        userRunCompletedAt: DateTime.formatIso(userAt),
        attention: null,
      });
      assert.deepEqual(row(alone), { origin: "wake", userRunCompletedAt: null, attention: null });
      assert.equal(row(marked).attention, "Pick a release date");
    }).pipe(Effect.provide(testLayer)),
);

const pullRequestLink = (number: number) => ({
  host: "github.com",
  repository: "owner/repository",
  number,
  url: `https://github.com/owner/repository/pull/${number}`,
  source: "manual" as const,
  linkedAt: DateTime.formatIso(old),
  snapshot: null,
  stack: null,
});

it.effect("sql: lists only active threads with pull request links, oldest first", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread("no-links");
    yield* createThread("empty-links", { pullRequests: [] });
    yield* createThread("archived-link", {
      archivedAt: old,
      pullRequests: [pullRequestLink(1)],
    });
    const settled = yield* createThread("settled-link", {
      settledOverride: "settled",
      settledAt: old,
      updatedAt: DateTime.subtract(now, { days: 12 }),
      pullRequests: [pullRequestLink(2)],
    });
    const open = yield* createThread("open-link", {
      pullRequests: [pullRequestLink(3), pullRequestLink(4)],
    });

    const threads = yield* store.getThreadsWithPullRequests();
    assert.deepEqual(
      threads.map((thread) => [thread.id, thread.settledOverride, thread.pullRequests?.length]),
      [
        [settled, "settled", 1],
        [open, null, 2],
      ],
    );
    assert.deepEqual(
      (yield* store.getThreadsWithPullRequests(open)).map((thread) => thread.id),
      [open],
    );
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: an unsettled-only shell read skips settled threads", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const open = yield* createThread("unsettled-open");
    const reopened = yield* createThread("unsettled-reopened", { settledOverride: "active" });
    yield* createThread("unsettled-manual", { settledOverride: "settled", settledAt: old });
    yield* createThread("unsettled-auto", { settledAt: old });
    yield* createThread("unsettled-archived", { archivedAt: old });

    const shell = yield* store.getShellSnapshot({ location: "active", unsettledOnly: true });
    assert.deepEqual(new Set(shell.threads.map((thread) => thread.id)), new Set([open, reopened]));
    assert.equal(shell.archivedThreads.length, 0);
    const all = yield* store.getShellSnapshot({ location: "active" });
    assert.equal(all.threads.length, 4);
  }).pipe(Effect.provide(layerSql)),
);

it.effect.each([["sql", layerSql]] as const)(
  "%s: a pinned-only shell read lists pinned threads of every project",
  ([, testLayer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const pinned = yield* createThread("pinned-here", { pinnedAt: old });
      const elsewhere = yield* createThread("pinned-elsewhere", {
        pinnedAt: old,
        projectId: ProjectId.make("project:settlement-other"),
      });
      yield* createThread("pinned-unpinned");
      yield* createThread("pinned-cleared", { pinnedAt: null });
      yield* createThread("pinned-archived", { pinnedAt: old, archivedAt: old });

      const shell = yield* store.getShellSnapshot({ location: "active", pinnedOnly: true });
      assert.deepEqual(
        new Set(shell.threads.map((thread) => thread.id)),
        new Set([pinned, elsewhere]),
      );
    }).pipe(Effect.provide(testLayer)),
);
