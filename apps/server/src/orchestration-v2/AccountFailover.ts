import {
  CommandId,
  isListedThreadLineage,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  BUDGET_FAILURE_CODE,
  chainNotice,
  isChainTrigger,
  SCHEDULE_BREAKER_STREAK,
  selectionFor,
  type TriggerReason,
} from "../fallback/fallbackChain.ts";
import * as ProviderFallback from "../fallback/ProviderFallback.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type AccountMove, planAccountMove } from "../usage/nextAccountInstances.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import {
  accountFailoverMessageId,
  isAccountFailoverMessage,
} from "./accountFailoverContinuation.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

type MessageDispatch = Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>;

const DAY = 24 * 60 * 60_000;
const NOTICE_KEY = "account";
const FALLBACK_NOTICE_KEY = "fallback";

/** A reset time in the server's zone; one more than a day away names its weekday. */
export function formatResetTime(at: number, now: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(at - now < DAY ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);
}

/**
 * The line a thread shows when its turn moves, stays because moving would end the used-up
 * account's background work, or stays because no other account is ready.
 */
export function accountMoveNotice(
  move: AccountMove,
  options: {
    readonly now: number;
    readonly label: (instanceId: ProviderInstanceId) => string;
    readonly formatTime?: (at: number, now: number) => string;
    readonly waitsForBackgroundWork?: boolean;
  },
): string {
  const time = (at: number) => (options.formatTime ?? formatResetTime)(at, options.now);
  const from = options.label(move.from);
  if (move.type === "move") {
    const until = move.usedUpUntil === null ? "" : ` until ${time(move.usedUpUntil)}`;
    const to = options.label(move.to);
    return options.waitsForBackgroundWork === true
      ? `Stays on ${from} for now: moving to ${to} would end ${from}'s running background agents and commands. ${from}'s usage limit is reached${until}.`
      : `Moved from ${from} to ${to}: ${from}'s usage limit is reached${until}.`;
  }
  return move.freesUp === null
    ? "No other account is ready."
    : `No other account is ready. ${options.label(move.freesUp.instanceId)} frees up first, at ${time(move.freesUp.at)}.`;
}

export interface AccountPlan {
  readonly move: AccountMove;
  readonly notice: string;
  /** For a move refused because it would end background work on the used-up account. */
  readonly waitingNotice: string;
}

export interface AccountFailoverPolicyShape {
  readonly plan: (input: {
    readonly projectId: ProjectId;
    readonly selection: ModelSelection;
    /** From the turn's usage-limit failure; omitted, the account's reading decides. */
    readonly usedUpUntil?: number | null;
    readonly busyInstances: ReadonlySet<ProviderInstanceId>;
  }) => Effect.Effect<AccountPlan | null>;
}

/**
 * Plans where a thread's turn goes when its account is used up, from this server's own accounts
 * and readings. Without it, as in most tests, no turn moves.
 */
export class AccountFailoverPolicy extends Context.Reference<AccountFailoverPolicyShape | null>(
  "t3/orchestration-v2/AccountFailover/AccountFailoverPolicy",
  { defaultValue: () => null },
) {}

export const layerPolicy = Layer.effect(
  AccountFailoverPolicy,
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const usageLimitSources = yield* Effect.serviceOption(UsageLimitSources.UsageLimitSources);
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return {
      plan: Effect.fn("AccountFailoverPolicy.plan")(function* (input) {
        const providers = yield* providerRegistry.getProviders;
        const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
        const now = yield* Clock.currentTimeMillis;
        const move = planAccountMove({
          environmentId: yield* environment.getEnvironmentId,
          providers,
          usageLimitSources: Option.isSome(usageLimitSources)
            ? yield* usageLimitSources.value.current
            : [],
          now,
          selection: input.selection,
          usable: (instanceId) =>
            resolveProjectProviderInstanceEnabled(settings, input.projectId, instanceId),
          ...(input.usedUpUntil === undefined ? {} : { usedUpUntil: input.usedUpUntil }),
          busyInstances: input.busyInstances,
        });
        if (move === null) return null;
        const label = (instanceId: ProviderInstanceId) =>
          providers.find((provider) => provider.instanceId === instanceId)?.displayName ??
          instanceId;
        return {
          move,
          notice: accountMoveNotice(move, { now, label }),
          waitingNotice: accountMoveNotice(move, { now, label, waitsForBackgroundWork: true }),
        };
      }),
    };
  }),
);

// Continuations and wakes keep the account of the turn they continue; a steer joins a running turn.
const startsTurn = (command: MessageDispatch) =>
  (command.dispatchMode.type === "start_immediately" ||
    command.dispatchMode.type === "queue_after_active" ||
    command.dispatchMode.type === "defer_start") &&
  command.restartContinuationOfRunId === undefined &&
  command.usageLimitContinuationOfRunId === undefined &&
  command.delegatedCompletion === undefined &&
  command.notification === undefined &&
  !isNativeMaintenanceCommand(command);

/**
 * A delegated task's thread fails as before: its parent hears of the failure and chooses, and a
 * continuation there would not report back to it. A side chat fails too, beside its parent.
 */
const threadMoves = (
  thread: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "settledOverride" | "accountFailoverDisabledAt" | "lineage"
  >,
) =>
  thread.archivedAt === null &&
  thread.settledOverride !== "settled" &&
  thread.accountFailoverDisabledAt == null &&
  isListedThreadLineage(thread.lineage);

export interface MovedCommand {
  readonly command: OrchestrationV2ServerCommand;
  /** Why the turn runs on another account, for its thread to show. */
  readonly notice: string | null;
}

/**
 * A message about to start a turn on an account its reading shows used up starts on the next
 * account instead, skipping the attempt that would fail. A thread with a turn in progress keeps
 * its account: the message joins or follows that turn.
 */
export const moveOffUsedUpAccount = Effect.fn("AccountFailover.moveOffUsedUpAccount")(
  function* (
    policy: AccountFailoverPolicyShape | null,
    orchestrator: Orchestrator.OrchestratorV2["Service"],
    sessions: ProviderSessionManager.ProviderSessionManagerV2["Service"],
    command: OrchestrationV2ServerCommand,
    fallback: ProviderFallback.ProviderFallbackPolicyShape | null = null,
  ) {
    const unchanged: MovedCommand = { command, notice: null };
    if (
      (policy === null && fallback === null) ||
      command.type !== "message.dispatch" ||
      !startsTurn(command)
    ) {
      return unchanged;
    }
    const shell = yield* orchestrator.getThreadShell(command.threadId);
    if (shell === null || shell.activeRunId !== null || !threadMoves(shell)) return unchanged;
    const selection = command.modelSelection ?? shell.modelSelection;
    if (fallback !== null) {
      const chained = yield* fallback.turnStart({ projectId: shell.projectId, selection });
      if (chained !== null) {
        return {
          command: { ...command, modelSelection: chained.selection },
          notice: `Fallback chain: this turn runs on ${chained.to}, the first ready entry, instead of ${chained.from}.`,
        } satisfies MovedCommand;
      }
      // The chain decides where its threads go; the account ranking does not move them.
      if (yield* fallback.onChain({ projectId: shell.projectId, selection })) return unchanged;
    }
    if (policy === null) return unchanged;
    const plan = yield* policy.plan({
      projectId: shell.projectId,
      selection,
      busyInstances: yield* sessions.busyInstances,
    });
    if (plan?.move.type !== "move") return unchanged;
    return {
      command: { ...command, modelSelection: { ...selection, instanceId: plan.move.to } },
      notice: plan.notice,
    } satisfies MovedCommand;
  },
  (effect, _policy, _orchestrator, _sessions, command, _fallback) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("checking the account of a new turn failed", {
          threadId: "threadId" in command ? command.threadId : undefined,
          cause,
        }).pipe(Effect.as<MovedCommand>({ command, notice: null })),
      ),
    ),
);

export class AccountFailoverReactor extends Context.Service<
  AccountFailoverReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/AccountFailover/AccountFailoverReactor") {}

// Switching accounts would end the used-up account's background work; the move waits for it.
const endsBackgroundWork = (error: Orchestrator.OrchestratorV2Error) =>
  error._tag === "OrchestratorDispatchError" &&
  error.cause === Orchestrator.SWITCH_ENDS_BACKGROUND_WORK;

/** The run a chain of moves started from: the turn whose entries the tried set counts. */
function moveOrigin(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run {
  let current = run;
  const seen = new Set<RunId>();
  while (
    isAccountFailoverMessage(current.userMessageId) &&
    current.manualContinuationOfRunId !== undefined &&
    !seen.has(current.id)
  ) {
    seen.add(current.id);
    const source = runs.find((candidate) => candidate.id === current.manualContinuationOfRunId);
    if (source === undefined) break;
    current = source;
  }
  return current;
}

const triggerReason = (
  failure: OrchestrationV2ProviderFailure | null,
  budgetStopped: boolean,
): TriggerReason | null => {
  if (budgetStopped || failure?.code === BUDGET_FAILURE_CODE) return { kind: "budget" };
  if (!isChainTrigger(failure)) return null;
  if (failure?.quota === "out_of_credit") return { kind: "out_of_credit" };
  const resetAt = failure?.resetAt == null ? Number.NaN : Date.parse(failure.resetAt);
  return { kind: "quota", until: Number.isFinite(resetAt) ? resetAt : null };
};

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const policy = yield* AccountFailoverPolicy;
  const fallback = yield* ProviderFallback.ProviderFallbackPolicy;
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTaskService);

  // The scheduled task a run serves, through the moves that continued it.
  const scheduledTaskOf = Effect.fn("AccountFailover.scheduledTaskOf")(function* (
    threadId: ThreadId,
    runs: ReadonlyArray<OrchestrationV2Run>,
    run: OrchestrationV2Run,
  ) {
    const origin = moveOrigin(runs, run);
    const records = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
      messageIds: [origin.userMessageId],
    });
    return records.messages.find((message) => message.id === origin.userMessageId)?.scheduledTaskId;
  });

  /** Moves a thread along its fallback chain; false when the run is not on one. */
  const moveAlongChain = Effect.fn("AccountFailover.moveAlongChain")(function* (input: {
    readonly fallback: ProviderFallback.ProviderFallbackPolicyShape;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly run: OrchestrationV2Run;
    readonly reason: TriggerReason;
    /** Retries after background work held a move back record nothing new. */
    readonly retryOf: RunId | undefined;
  }) {
    const { run, threadId } = input;
    if (
      !(yield* input.fallback.onChain({
        projectId: input.projectId,
        selection: run.modelSelection,
      }))
    ) {
      return false;
    }
    const origin = moveOrigin(input.runs, run);
    const move = yield* input.fallback.afterFailure({
      threadId,
      projectId: input.projectId,
      originRunId: origin.id,
      selection: run.modelSelection,
      reason: input.reason,
      record: input.retryOf === undefined,
    });
    if (move === null) return true;
    const now = yield* Clock.currentTimeMillis;
    const time = (at: number) => formatResetTime(at, now);
    let notice = chainNotice(move.plan, { reason: input.reason, label: move.label, time });
    const attempt = input.retryOf === undefined ? run.id : `${run.id}:${input.retryOf}`;
    if (move.plan.type === "move") {
      const to = move.plan.to;
      const moved = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:provider-fallback:${attempt}`),
          threadId,
          messageId: accountFailoverMessageId(run.id),
          // The new entry reads the thread's handoff and a note on where the turn was cut off.
          text: "",
          attachments: [],
          modelSelection: selectionFor(to.entry),
          manualContinuationOfRunId: run.id,
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.as(true),
          Effect.catchIf(endsBackgroundWork, () => Effect.succeed(false)),
        );
      if (!moved) {
        notice = `Fallback chain: stays on ${move.label(move.plan.from)} for now: moving would end its running background agents and commands.`;
      } else {
        yield* input.fallback.markTried({ threadId, originRunId: origin.id, entry: to });
        if (input.runs.some((candidate) => candidate.status === "queued")) {
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`server:provider-fallback:queue:${attempt}`),
            threadId,
          });
        }
      }
    } else if (input.retryOf === undefined) {
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`server:provider-fallback:attention:${run.id}`),
        threadId,
        attention: { reason: "Every entry of the provider fallback chain is used up." },
      });
      const scheduleId = yield* scheduledTaskOf(threadId, input.runs, run);
      if (scheduleId !== undefined) {
        const trips = yield* input.fallback.scheduleOutcome({ scheduleId, exhausted: true });
        if (trips && Option.isSome(scheduledTasks)) {
          yield* scheduledTasks.value.setEnabled({ id: scheduleId, enabled: false });
          notice = `${notice} Its schedule exhausted the chain ${SCHEDULE_BREAKER_STREAK} runs in a row and is paused; turn it back on in Schedules.`;
        }
      }
    }
    yield* orchestrator.recordRunNotice({
      threadId,
      runId: run.id,
      key: FALLBACK_NOTICE_KEY,
      message: notice,
    });
    return true;
  });

  // Runs for every run update and creation; all but a failed, interrupted or queued run return
  // at once. A run queued behind the limited one is a wake, often from background work ending:
  // that work may have held the move back, so the move is tried again.
  const handle: AccountFailoverReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (policy === null && fallback === null) return;
      const failedRunId =
        event.type === "run.updated" && event.payload.status === "failed"
          ? event.payload.id
          : undefined;
      // Only the budget check interrupts a run for the chain; any other stop stays put.
      const interruptedRunId =
        fallback !== null && event.type === "run.updated" && event.payload.status === "interrupted"
          ? event.payload.id
          : undefined;
      const queuedRunId =
        event.type === "run.created" && event.payload.status === "queued"
          ? event.payload.id
          : undefined;
      if (
        failedRunId === undefined &&
        queuedRunId === undefined &&
        interruptedRunId === undefined
      ) {
        return;
      }
      const endedRunId = failedRunId ?? interruptedRunId;
      const budgetStopped =
        interruptedRunId !== undefined &&
        fallback !== null &&
        (yield* fallback.reservation(interruptedRunId))?.stoppedAt != null;
      if (interruptedRunId !== undefined && !budgetStopped) return;
      const projection = yield* orchestrator.getThreadRecords(
        event.threadId,
        ["runs", "runtimeRequests", "turnItems"],
        {
          turnItemTypes: ["error"],
          ...(endedRunId === undefined ? {} : { turnItemRunIds: [endedRunId] }),
        },
      );
      const run = latestExecutedRun(projection.runs);
      const failure = latestRootProviderFailure(run, projection.turnItems);
      if (
        run === null ||
        (endedRunId !== undefined && run.id !== endedRunId) ||
        projection.thread.deletedAt !== null ||
        !threadMoves(projection.thread) ||
        projection.runtimeRequests.some((request) => request.status === "pending")
      ) {
        return;
      }
      const reason = triggerReason(failure, budgetStopped);
      if (
        fallback !== null &&
        reason !== null &&
        (yield* moveAlongChain({
          fallback,
          threadId: event.threadId,
          projectId: projection.thread.projectId,
          runs: projection.runs,
          run,
          reason,
          retryOf: queuedRunId,
        }))
      ) {
        return;
      }
      if (
        policy === null ||
        failure?.class !== "usage_limit" ||
        // A turn that already continues a move does not move again.
        isAccountFailoverMessage(run.userMessageId)
      ) {
        return;
      }
      const resetAt = failure.resetAt == null ? Number.NaN : Date.parse(failure.resetAt);
      const plan = yield* policy.plan({
        projectId: projection.thread.projectId,
        selection: run.modelSelection,
        usedUpUntil: Number.isFinite(resetAt) ? resetAt : null,
        busyInstances: yield* sessions.busyInstances,
      });
      if (plan === null) {
        yield* Effect.logInfo("no account to move a used-up thread to", {
          threadId: event.threadId,
          runId: run.id,
          instanceId: run.providerInstanceId,
        });
        return;
      }
      // A refused attempt's command id stays refused, so each retry needs its own.
      const attempt = queuedRunId === undefined ? run.id : `${run.id}:${queuedRunId}`;
      let notice = plan.notice;
      if (plan.move.type === "move") {
        const moved = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`server:account-failover:${attempt}`),
            threadId: event.threadId,
            messageId: accountFailoverMessageId(run.id),
            // A manual continuation resumes natively; the conversation gets no message text.
            text: "",
            attachments: [],
            modelSelection: { ...run.modelSelection, instanceId: plan.move.to },
            manualContinuationOfRunId: run.id,
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(
            Effect.as(true),
            Effect.catchIf(endsBackgroundWork, () => Effect.succeed(false)),
          );
        if (!moved) {
          notice = plan.waitingNotice;
        } else if (projection.runs.some((candidate) => candidate.status === "queued")) {
          // As Resume does after a limit: messages waiting behind the failed turn follow it.
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`server:account-failover:queue:${attempt}`),
            threadId: event.threadId,
          });
        }
      }
      yield* orchestrator.recordRunNotice({
        threadId: event.threadId,
        runId: run.id,
        key: NOTICE_KEY,
        message: notice,
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("moving a thread off its used-up account failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: AccountFailoverReactor["Service"]["start"] = () =>
    forkParked(
      Stream.unwrap(
        eventSink
          .latestSequence()
          .pipe(
            Effect.map((latest) =>
              Stream.merge(
                eventSink.stream({ afterSequence: latest, eventType: "run.updated" }),
                eventSink.stream({ afterSequence: latest, eventType: "run.created" }),
              ),
            ),
          ),
      ).pipe(
        Stream.runForEach((stored) => handle(stored.event)),
        Effect.catchCause((cause) =>
          Effect.logWarning("account failover event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies AccountFailoverReactor["Service"];
});

export const layerReactor = Layer.effect(AccountFailoverReactor, make);

/** Records why a turn that `moveOffUsedUpAccount` moved runs where it does. */
export const recordMoveNotice = Effect.fn("AccountFailover.recordMoveNotice")(
  function* (
    orchestrator: Orchestrator.OrchestratorV2["Service"],
    moved: MovedCommand,
    result: Orchestrator.OrchestratorV2DispatchResult,
  ) {
    const { command, notice } = moved;
    if (notice === null || command.type !== "message.dispatch") return;
    const created = result.storedEvents.find(
      (stored) =>
        stored.event.type === "run.created" &&
        stored.event.payload.userMessageId === command.messageId,
    );
    if (created === undefined || created.event.type !== "run.created") return;
    yield* orchestrator.recordRunNotice({
      threadId: command.threadId,
      runId: created.event.payload.id,
      key: NOTICE_KEY,
      message: notice,
    });
  },
  (effect, _orchestrator, moved) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("recording an account move failed", {
          command: moved.command.commandId,
          cause,
        }),
      ),
    ),
);
