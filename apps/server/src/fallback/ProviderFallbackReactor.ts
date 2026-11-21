import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type ProviderTurnId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  isAccountFailoverMessage,
  moveOrigin,
} from "../orchestration-v2/accountFailoverContinuation.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { ProviderFallbackPolicy, type ProviderFallbackPolicyShape } from "./ProviderFallback.ts";

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

interface WatchedRun {
  readonly threadId: ThreadId;
  readonly selection: ModelSelection;
  readonly capUsd: number;
  readonly turns: Map<ProviderTurnId, OrchestrationV2ProviderTurn>;
  stopping: boolean;
}

/**
 * Keeps budgeted runs under their cap: it prices each usage update and interrupts the run at the
 * cap, so the failover reactor moves the turn on. It settles each run's cost when the run ends,
 * clears an entry's cool-down when a turn completes on it, and ends a schedule's streak when a
 * scheduled run completes.
 */
export class ProviderFallbackReactor extends Context.Service<
  ProviderFallbackReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Settles what a restart left in flight and watches the runs still going. */
    readonly reconcile: Effect.Effect<void>;
  }
>()("t3/fallback/ProviderFallbackReactor") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const fallback = yield* ProviderFallbackPolicy;
  const watched = new Map<RunId, WatchedRun>();
  // Runs found to have no reservation, so their further updates read nothing.
  const unbudgeted = new Set<RunId>();

  const runTurns = Effect.fn("ProviderFallbackReactor.runTurns")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const records = yield* orchestrator.getThreadRecords(threadId, [
      "runs",
      "attempts",
      "providerTurns",
    ]);
    const attempts = new Set(
      records.attempts.filter((attempt) => attempt.runId === runId).map((attempt) => attempt.id),
    );
    return {
      run: records.runs.find((run) => run.id === runId),
      turns: records.providerTurns.filter(
        (turn) => turn.runAttemptId !== null && attempts.has(turn.runAttemptId),
      ),
    };
  });

  const settle = Effect.fn("ProviderFallbackReactor.settle")(function* (
    policy: ProviderFallbackPolicyShape,
    threadId: ThreadId,
    runId: RunId,
  ) {
    watched.delete(runId);
    const reservation = yield* policy.reservation(runId);
    if (reservation === null || reservation.chargedUsd !== null) return;
    const { run, turns } = yield* runTurns(threadId, runId);
    // A run that never reached its provider spent nothing; one that did, without a cost, its cap.
    const costUsd =
      run === undefined
        ? null
        : turns.length === 0
          ? 0
          : yield* policy.runCost({ selection: run.modelSelection, providerTurns: turns });
    yield* policy.settle({ runId, costUsd });
  });

  const check = Effect.fn("ProviderFallbackReactor.check")(function* (
    policy: ProviderFallbackPolicyShape,
    runId: RunId,
    run: WatchedRun,
  ) {
    if (run.stopping) return;
    const cost = yield* policy.runCost({
      selection: run.selection,
      providerTurns: [...run.turns.values()],
    });
    if (cost === null || cost < run.capUsd) return;
    run.stopping = true;
    yield* policy.markBudgetStopped(runId);
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`server:provider-fallback:budget-stop:${runId}`),
      threadId: run.threadId,
      runId,
      reason: "The run reached its budget cap.",
    });
  });

  const handle: ProviderFallbackReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (fallback === null) return;
      if (event.type === "provider-turn.updated") {
        const run = event.runId === undefined ? undefined : watched.get(event.runId);
        if (run === undefined || event.payload.turnTokenUsage === undefined) return;
        run.turns.set(event.payload.id, event.payload);
        yield* check(fallback, event.runId!, run);
        return;
      }
      if (event.type !== "run.updated") return;
      const run = event.payload;
      if (run.status === "running" && !watched.has(run.id)) {
        if (unbudgeted.has(run.id)) return;
        const reservation = yield* fallback.reservation(run.id);
        if (reservation === null || reservation.chargedUsd !== null) {
          unbudgeted.add(run.id);
          return;
        }
        watched.set(run.id, {
          threadId: event.threadId,
          selection: run.modelSelection,
          capUsd: reservation.capUsd,
          turns: new Map(),
          stopping: reservation.stoppedAt !== null,
        });
        return;
      }
      if (!TERMINAL.has(run.status)) return;
      if (!unbudgeted.delete(run.id)) yield* settle(fallback, event.threadId, run.id);
      if (run.status !== "completed") return;
      if (run.startedAt !== null) {
        yield* fallback.completed({
          selection: run.modelSelection,
          startedAt: DateTime.toEpochMillis(run.startedAt),
        });
      }
      // A scheduled turn that completed, also after moving along the chain, ends the streak.
      const moved = isAccountFailoverMessage(run.userMessageId);
      if (run.origin !== "schedule" && !moved) return;
      const origin = moved
        ? moveOrigin((yield* orchestrator.getThreadRecords(event.threadId, ["runs"])).runs, run)
        : run;
      const records = yield* orchestrator.getThreadRecords(event.threadId, ["messages"], {
        messageIds: [origin.userMessageId],
      });
      const scheduleId = records.messages.find(
        (message) => message.id === origin.userMessageId,
      )?.scheduledTaskId;
      if (scheduleId !== undefined) {
        yield* fallback.scheduleOutcome({ scheduleId, runId: origin.id, exhausted: false });
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider fallback: handling a run event failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const reconcile: ProviderFallbackReactor["Service"]["reconcile"] = Effect.gen(function* () {
    if (fallback === null) return;
    for (const reservation of yield* fallback.openReservations) {
      const threadId = reservation.threadId as ThreadId;
      const runId = reservation.runId as RunId;
      const { run, turns } = yield* runTurns(threadId, runId);
      if (run === undefined || TERMINAL.has(run.status)) {
        yield* settle(fallback, threadId, runId);
        continue;
      }
      if (run.status !== "running") continue;
      const watchedRun: WatchedRun = {
        threadId,
        selection: run.modelSelection,
        capUsd: reservation.capUsd,
        turns: new Map(turns.map((turn) => [turn.id, turn])),
        stopping: reservation.stoppedAt !== null,
      };
      watched.set(runId, watchedRun);
      yield* check(fallback, runId, watchedRun);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("provider fallback: reconciling budgets failed", { cause }),
    ),
  );

  const start: ProviderFallbackReactor["Service"]["start"] = () =>
    fallback === null
      ? Effect.void
      : forkParked(
          Stream.unwrap(
            eventSink.latestSequence().pipe(
              Effect.tap(() => reconcile),
              Effect.map((latest) =>
                Stream.merge(
                  eventSink.stream({ afterSequence: latest, eventType: "run.updated" }),
                  eventSink.stream({ afterSequence: latest, eventType: "provider-turn.updated" }),
                ),
              ),
            ),
          ).pipe(
            Stream.runForEach((stored) => handle(stored.event)),
            Effect.catchCause((cause) =>
              Effect.logWarning("provider fallback event stream failed", { cause }),
            ),
          ),
        );

  return { start, handle, reconcile } satisfies ProviderFallbackReactor["Service"];
});

export const layer = Layer.effect(ProviderFallbackReactor, make);
