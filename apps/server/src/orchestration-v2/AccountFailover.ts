import {
  CommandId,
  isListedThreadLineage,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
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

type MessageDispatch = Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>;

const DAY = 24 * 60 * 60_000;
const NOTICE_KEY = "account";

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

/** The line a thread shows when its turn moves, or stays because no other account is ready. */
export function accountMoveNotice(
  move: AccountMove,
  options: {
    readonly now: number;
    readonly label: (instanceId: ProviderInstanceId) => string;
    readonly formatTime?: (at: number, now: number) => string;
  },
): string {
  const time = (at: number) => (options.formatTime ?? formatResetTime)(at, options.now);
  const from = options.label(move.from);
  if (move.type === "move") {
    const until = move.usedUpUntil === null ? "" : ` until ${time(move.usedUpUntil)}`;
    return `Moved from ${from} to ${options.label(move.to)}: ${from}'s usage limit is reached${until}.`;
  }
  return move.freesUp === null
    ? "No other account is ready."
    : `No other account is ready. ${options.label(move.freesUp.instanceId)} frees up first, at ${time(move.freesUp.at)}.`;
}

export interface AccountPlan {
  readonly move: AccountMove;
  readonly notice: string;
}

export interface AccountFailoverPolicyShape {
  readonly plan: (input: {
    readonly projectId: ProjectId;
    readonly selection: ModelSelection;
    /** From the turn's usage-limit failure; omitted, the account's reading decides. */
    readonly usedUpUntil?: number | null;
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
        });
        if (move === null) return null;
        const label = (instanceId: ProviderInstanceId) =>
          providers.find((provider) => provider.instanceId === instanceId)?.displayName ??
          instanceId;
        return { move, notice: accountMoveNotice(move, { now, label }) };
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
    command: OrchestrationV2ServerCommand,
  ) {
    const unchanged: MovedCommand = { command, notice: null };
    if (policy === null || command.type !== "message.dispatch" || !startsTurn(command)) {
      return unchanged;
    }
    const shell = yield* orchestrator.getThreadShell(command.threadId);
    if (shell === null || shell.activeRunId !== null || !threadMoves(shell)) return unchanged;
    const selection = command.modelSelection ?? shell.modelSelection;
    const plan = yield* policy.plan({ projectId: shell.projectId, selection });
    if (plan?.move.type !== "move") return unchanged;
    return {
      command: { ...command, modelSelection: { ...selection, instanceId: plan.move.to } },
      notice: plan.notice,
    } satisfies MovedCommand;
  },
  (effect, _policy, _orchestrator, command) =>
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

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const policy = yield* AccountFailoverPolicy;

  // Runs for every run update; all but a failed run return at once.
  const handle: AccountFailoverReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (policy === null || event.type !== "run.updated" || event.payload.status !== "failed") {
        return;
      }
      const projection = yield* orchestrator.getThreadRecords(
        event.threadId,
        ["runs", "runtimeRequests", "turnItems"],
        { turnItemTypes: ["error"], turnItemRunIds: [event.payload.id] },
      );
      const run = latestExecutedRun(projection.runs);
      const failure = latestRootProviderFailure(run, projection.turnItems);
      if (
        run === null ||
        run.id !== event.payload.id ||
        failure?.class !== "usage_limit" ||
        projection.thread.deletedAt !== null ||
        !threadMoves(projection.thread) ||
        projection.runtimeRequests.some((request) => request.status === "pending") ||
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
      });
      if (plan === null) return;
      if (plan.move.type === "move") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:account-failover:${run.id}`),
          threadId: event.threadId,
          messageId: accountFailoverMessageId(run.id),
          text: "Continue where you left off.",
          attachments: [],
          modelSelection: { ...run.modelSelection, instanceId: plan.move.to },
          manualContinuationOfRunId: run.id,
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        });
        // As Resume does after a limit: messages waiting behind the failed turn follow it.
        if (projection.runs.some((candidate) => candidate.status === "queued")) {
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`server:account-failover:queue:${run.id}`),
            threadId: event.threadId,
          });
        }
      }
      yield* orchestrator.recordRunNotice({
        threadId: event.threadId,
        runId: run.id,
        key: NOTICE_KEY,
        message: plan.notice,
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
              eventSink.stream({ afterSequence: latest, eventType: "run.updated" }),
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
