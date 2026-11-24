import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  isUserPinnedThread,
  MessageId,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ThreadMemory from "../memory/ThreadMemory.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { idleCompactionWindow, MAKE_UP_MAX_IDLE_MS } from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isTerminalRunStatus } from "./ThreadManagementService.ts";

// Timers stall while the machine sleeps on most platforms, the wall clock does not: a long wait
// re-reads the clock this often, so a slot the sleep swallowed is noticed soon after waking.
const CLOCK_CHECK_MS = 60_000;
// A make-up compaction holds its turn in the queue until its run ends, or at most this long.
const MAKE_UP_HOLD_MS = 10 * 60_000;

/**
 * When a run completes on a Claude thread, waits until the window `idleCompactionWindow` names
 * (a minute after the turn near the limit, or shortly before the prompt cache expires) and sends
 * `/compact` as a visible T3 Code turn. A slot missed while the machine slept or the server was
 * stopped is made up when the server notices, one thread at a time.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Each make-up resumes a large session and re-reads it uncached, so they run one at a time.
  const makeUps = yield* Semaphore.make(1);
  const makeUpRuns = new Map<MessageId, Deferred.Deferred<void>>();

  const compactWhenDue = Effect.fn("IdleCompactionService.compactWhenDue")(
    function* (threadId: ThreadId, completedRunId: RunId, afterRestart = false) {
      let runId = completedRunId;
      // Set once the server may have missed the slot: after a restart, or after waiting for it.
      let makeUp = afterRestart;
      let queued = false;
      // Loops after the wait or a retarget: the thread may have moved on.
      while (true) {
        const current = yield* settings.getSettings;
        const thread = yield* projections.getThread(threadId);
        const claudeInstance = Object.hasOwn(current.providerInstances, thread.providerInstanceId)
          ? current.providerInstances[thread.providerInstanceId]?.driver === "claudeAgent"
          : thread.providerInstanceId === "claudeAgent";
        if (
          !claudeInstance ||
          resolveIdleCompaction(current, thread.providerInstanceId) === "off" ||
          !resolveProjectProviderInstanceEnabled(
            current,
            thread.projectId,
            thread.providerInstanceId,
          )
        )
          return;
        const activeProviderThreadIds =
          thread.activeProviderThreadId === null ? [] : [thread.activeProviderThreadId];
        const records = yield* projections.getThreadRecords(
          threadId,
          [
            "runs",
            "messages",
            "providerThreads",
            "providerTurns",
            "runtimeRequests",
            "turnItems",
            "contextTransfers",
          ],
          {
            messageRunIds: [runId],
            turnItemStatuses: ["pending", "running", "waiting"],
            // The latest run, active runs that hold background work, and rolled-back runs whose
            // items it ignores.
            runStatuses: ["preparing", "starting", "running", "rolled_back"],
            includeLatestRun: true,
            // Without an active provider thread there is no session to compact.
            providerThreadIds: activeProviderThreadIds,
            providerTurnThreadIds: activeProviderThreadIds,
            latestProviderTurnUsageOnly: true,
            runtimeRequestStatuses: ["pending"],
            contextTransferStatuses: ["pending"],
          },
        );
        if (
          !resolveProjectProviderInstanceEnabled(
            current,
            records.thread.projectId,
            records.thread.providerInstanceId,
          )
        )
          return;
        const latestRun = records.runs
          .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
          .reduce<(typeof records.runs)[number] | undefined>(
            (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
            undefined,
          );
        // A late update for an earlier run replaced the latest run's timer, so take it over.
        if (latestRun?.status === "completed" && latestRun.id !== runId) {
          if (queued) return;
          runId = latestRun.id;
          continue;
        }
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const mode = resolveIdleCompaction(current, records.thread.providerInstanceId);
        // A restart makes up cache slots only; the near-limit compaction keeps to its own timer.
        let window = idleCompactionWindow(records, nowMs, mode, {
          compactNearLimit: !afterRestart,
          makeUp,
        });
        const providerThreadId = records.thread.activeProviderThreadId;
        // The memory reminder rides on the next turn, which would be this `/compact`. Leave that
        // turn to the user, so the agent saves its memory before Claude compacts.
        if (
          window?.reason === "nearLimit" &&
          providerThreadId !== null &&
          current.pinnedThreadsKeepMemory &&
          isUserPinnedThread(records.thread) &&
          ThreadMemory.memoryNudgeDue(
            (yield* projections.getThreadRecords(threadId, ["providerTurns"], {
              providerTurnThreadIds: [providerThreadId],
            })).providerTurns,
            providerThreadId,
          )
        ) {
          window = idleCompactionWindow(records, nowMs, mode, { compactNearLimit: false, makeUp });
        }
        if (window?.runId !== runId) return;
        if (nowMs < window.startMs) {
          let wallMs = nowMs;
          while (wallMs < window.startMs) {
            yield* Effect.sleep(Duration.millis(Math.min(window.startMs - wallMs, CLOCK_CHECK_MS)));
            wallMs = DateTime.toEpochMillis(yield* DateTime.now);
          }
          makeUp = true;
          continue;
        }
        // Queued make-ups check again once it is their turn: the user may have sent meanwhile.
        if (window.reason === "missedSlot" && !queued) {
          yield* makeUps.takeScoped(1);
          queued = true;
          continue;
        }
        const messageId = MessageId.make(`idle-compact:${threadId}:${runId}`);
        const dispatch = orchestrator.dispatch({
          type: "message.dispatch",
          // One compaction per completed run, even across duplicate events.
          commandId: CommandId.make(`server:idle-compact:${threadId}:${runId}`),
          messageId,
          threadId,
          text: IDLE_COMPACTION_TEXT,
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          // Marks every compaction the server sends on its own; a new tag would fail older clients.
          idleCompaction: "beforeCacheExpires",
          dispatchMode: { type: "start_immediately" },
        });
        if (!queued) {
          yield* dispatch;
          return;
        }
        const ended = yield* Deferred.make<void>();
        makeUpRuns.set(messageId, ended);
        yield* dispatch.pipe(
          Effect.andThen(
            Deferred.await(ended).pipe(Effect.timeoutOption(Duration.millis(MAKE_UP_HOLD_MS))),
          ),
          Effect.ensuring(Effect.sync(() => makeUpRuns.delete(messageId))),
        );
        return;
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.scoped,
        Effect.catch((cause) => Effect.logWarning("idle compaction skipped", { threadId, cause })),
      ),
  );

  const start = Effect.fn("IdleCompactionService.start")(function* () {
    // Keyed by thread: a newer completed run replaces the waiting timer.
    const timers = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
            if (event.type !== "run.updated" || !isTerminalRunStatus(event.payload.status))
              return Effect.void;
            const makeUpRun = makeUpRuns.get(event.payload.userMessageId);
            return Effect.andThen(
              makeUpRun === undefined ? Effect.void : Deferred.succeed(makeUpRun, undefined),
              event.payload.status === "completed"
                ? FiberMap.run(
                    timers,
                    event.threadId,
                    compactWhenDue(event.threadId, event.payload.id),
                  )
                : Effect.void,
            );
          }),
        );
        // Timers live in memory: re-arm those a stop dropped, and make up slots it missed.
        const since = DateTime.subtractDuration(
          yield* DateTime.now,
          Duration.millis(MAKE_UP_MAX_IDLE_MS),
        );
        for (const candidate of yield* projections.getIdleCompactionCandidates(since)) {
          yield* FiberMap.run(
            timers,
            candidate.threadId,
            compactWhenDue(candidate.threadId, candidate.runId, true),
            { onlyIfMissing: true },
          );
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("idle compaction start-up scan failed", { cause }),
        ),
      ),
    );
  });
  return { start };
});
