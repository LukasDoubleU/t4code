import {
  type ModelSelection,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderTurn,
  type ProjectId,
  type ProviderFallbackEntryStatus,
  type ProviderFallbackStatus,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  type ThreadId,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { HttpClient } from "effect/http";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "../usage/UsageService.ts";
import {
  BUDGET_FAILURE_CODE,
  backoffMs,
  budgetKeyFor,
  type ChainEntry,
  type ChainPlan,
  chainEntries,
  cutOffNote,
  type EntryBlock,
  findChainEntry,
  firstReadyEntry,
  monthlyBudgetFor,
  monthOf,
  nextMonthStart,
  REFUSED_FAILURE_CODE,
  planChainMove,
  SCHEDULE_BREAKER_STREAK,
  selectionFor,
  type TriggerReason,
} from "./fallbackChain.ts";
import {
  checkOpenRouterKey,
  isOpenRouterEntry,
  NO_KEY,
  type OpenRouterKeyCheck,
  readOpenRouterKey,
} from "./openRouterKey.ts";
import {
  type EntryState,
  entryKey,
  ProviderFallbackStore,
  type Reservation,
} from "./ProviderFallbackStore.ts";

const KEY_CHECK_TTL_MS = 6 * 60 * 60_000;
// A refused key is checked again soon, so a limit set on openrouter.ai takes effect quickly.
const KEY_REFUSED_TTL_MS = 15 * 60_000;
const KEY_RETRY_TTL_MS = 5 * 60_000;

export interface ChainMove {
  readonly plan: ChainPlan;
  readonly label: (entry: ChainEntry) => string;
}

export interface ProviderFallbackPolicyShape {
  /**
   * A new turn on a chain entry starts on the first entry that is ready, so an earlier entry
   * takes turns again once it resets. Null keeps the selection.
   */
  readonly turnStart: (input: {
    readonly projectId: ProjectId;
    readonly selection: ModelSelection;
  }) => Effect.Effect<{
    readonly selection: ModelSelection;
    readonly from: string;
    readonly to: string;
  } | null>;
  /** Whether a run on `selection` belongs to the project's chain. */
  readonly onChain: (input: {
    readonly projectId: ProjectId;
    readonly selection: ModelSelection;
  }) => Effect.Effect<boolean>;
  /**
   * Records why the entry stopped (cool-down, parking or spent budget) and the attempt, then
   * plans where the turn goes. Null when the selection is not on the project's chain.
   */
  readonly afterFailure: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly originRunId: RunId;
    readonly selection: ModelSelection;
    /** The run that stopped; a run reported twice is recorded once. */
    readonly runId: RunId;
    readonly reason: TriggerReason;
    /** False on a retry after background work held the move back: the stop is recorded. */
    readonly record: boolean;
  }) => Effect.Effect<ChainMove | null>;
  readonly markTried: (input: {
    readonly threadId: ThreadId;
    readonly originRunId: RunId;
    readonly entry: ChainEntry;
  }) => Effect.Effect<void>;
  /** Reserves the run's budget before it starts; a failure refuses the turn. */
  readonly reserveTurn: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly runId: RunId;
    readonly selection: ModelSelection;
  }) => Effect.Effect<OrchestrationV2ProviderFailure | null>;
  readonly reservation: (runId: RunId) => Effect.Effect<Reservation | null>;
  readonly openReservations: Effect.Effect<ReadonlyArray<Reservation>>;
  /** The run's cost so far; null when nothing reports or prices it. */
  readonly runCost: (input: {
    readonly selection: ModelSelection;
    readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  }) => Effect.Effect<number | null>;
  /** Unknown cost is charged at the run's cap. */
  readonly settle: (input: {
    readonly runId: RunId;
    readonly costUsd: number | null;
  }) => Effect.Effect<void>;
  readonly markBudgetStopped: (runId: RunId) => Effect.Effect<void>;
  /** A completed turn ends its entry's cool-down and backoff, unless it stopped since. */
  readonly completed: (input: {
    readonly selection: ModelSelection;
    readonly startedAt: number;
  }) => Effect.Effect<void>;
  /** The first line a turn moved to another driver reads, naming where it was cut off. */
  readonly continuationNote: (input: {
    readonly from: ModelSelection;
    readonly to: ModelSelection;
  }) => Effect.Effect<string | null>;
  /** True when a scheduled run's outcome trips the breaker: pause the schedule, ask once. */
  readonly scheduleOutcome: (input: {
    readonly scheduleId: string;
    /** The scheduled run, which counts once however often it is reported. */
    readonly runId: RunId;
    readonly exhausted: boolean;
  }) => Effect.Effect<boolean>;
  readonly status: (projectId: ProjectId | null) => Effect.Effect<ProviderFallbackStatus>;
  readonly reenable: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
}

/** Without it, as in most tests, no thread follows a chain. */
export class ProviderFallbackPolicy extends Context.Reference<ProviderFallbackPolicyShape | null>(
  "t3/fallback/ProviderFallbackPolicy",
  { defaultValue: () => null },
) {}

const logged =
  <B>(operation: string, fallback: B) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`provider fallback: ${operation} failed`, { cause }).pipe(
          Effect.as(fallback),
        ),
      ),
    );

const make = Effect.gen(function* () {
  const store = yield* ProviderFallbackStore;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const usage = yield* Effect.serviceOption(UsageService.UsageService);
  const keyChecks = new Map<
    ProviderInstanceId,
    { readonly check: OpenRouterKeyCheck; readonly at: number }
  >();
  // The OpenRouter key check reads the CLI's auth store and calls OpenRouter.
  const keyCheckContext = yield* Effect.context<
    HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
  >();

  const keyCheck = Effect.fn("ProviderFallback.keyCheck")(function* (
    provider: ServerProvider,
    now: number,
  ) {
    const cached = keyChecks.get(provider.instanceId);
    if (
      cached !== undefined &&
      now - cached.at <
        (cached.check.ok
          ? KEY_CHECK_TTL_MS
          : cached.check.retry
            ? KEY_RETRY_TTL_MS
            : KEY_REFUSED_TTL_MS)
    ) {
      return cached.check;
    }
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const instance = deriveProviderInstanceConfigMap(settings)[provider.instanceId];
    const environment = yield* mergeProviderInstanceEnvironment(
      instance?.environment,
      process.env,
    ).pipe(Effect.orElseSucceed(() => ({ ...process.env })));
    const key = yield* readOpenRouterKey(provider.driver, environment).pipe(
      Effect.orElseSucceed(() => null),
    );
    const check: OpenRouterKeyCheck =
      key === null ? { ok: false, reason: NO_KEY, retry: true } : yield* checkOpenRouterKey(key);
    keyChecks.set(provider.instanceId, { check, at: now });
    return check;
  }, Effect.provideContext(keyCheckContext));

  interface Readings {
    readonly now: number;
    readonly chain: ReadonlyArray<ChainEntry>;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly states: ReadonlyMap<string, EntryState>;
    readonly totals: ReadonlyMap<
      string,
      { readonly spentUsd: number; readonly reservedUsd: number }
    >;
    readonly usable: (instanceId: ProviderInstanceId) => boolean;
    readonly keyChecks: ReadonlyMap<ProviderInstanceId, OpenRouterKeyCheck>;
  }

  const read = Effect.fn("ProviderFallback.read")(function* (projectId: ProjectId | null) {
    const now = yield* Clock.currentTimeMillis;
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const chain = chainEntries(
      resolveProjectSettings(settings, projectId).settings.providerFallbackChain,
    );
    const providers = yield* registry.getProviders;
    const states =
      chain.length === 0
        ? new Map<string, EntryState>()
        : new Map((yield* store.entryStates()).map((state) => [state.key, state]));
    const totals = chain.some(({ entry }) => entry.budget !== undefined)
      ? yield* store.monthTotals(monthOf(now))
      : new Map();
    const checks = new Map<ProviderInstanceId, OpenRouterKeyCheck>();
    for (const { entry } of chain) {
      const provider = providers.find((candidate) => candidate.instanceId === entry.instanceId);
      if (provider !== undefined && isOpenRouterEntry(provider.driver, entry.model)) {
        checks.set(entry.instanceId, yield* keyCheck(provider, now));
      }
    }
    return {
      now,
      chain,
      providers,
      states,
      totals,
      usable: (instanceId: ProviderInstanceId) =>
        resolveProjectProviderInstanceEnabled(settings, projectId, instanceId),
      keyChecks: checks,
    } satisfies Readings;
  });

  const budgetRoom = (readings: Readings, entry: ChainEntry) => {
    const monthly = monthlyBudgetFor(readings.chain, entry.entry);
    if (monthly === undefined) return Infinity;
    const totals = readings.totals.get(budgetKeyFor(entry.entry));
    return monthly - (totals?.spentUsd ?? 0) - (totals?.reservedUsd ?? 0);
  };

  const blockOf =
    (readings: Readings, tried: ReadonlySet<string> = new Set()) =>
    (entry: ChainEntry): EntryBlock | null => {
      if (tried.has(entry.key)) return { kind: "tried" };
      const provider = readings.providers.find(
        (candidate) => candidate.instanceId === entry.entry.instanceId,
      );
      // As the model picker shows it: a provider that is missing or erroring cannot take a turn.
      if (
        provider === undefined ||
        !provider.enabled ||
        provider.status === "error" ||
        provider.availability === "unavailable" ||
        !readings.usable(entry.entry.instanceId)
      ) {
        return { kind: "unavailable" };
      }
      const check = readings.keyChecks.get(entry.entry.instanceId);
      if (check !== undefined && !check.ok) return { kind: "refused", reason: check.reason };
      if (readings.states.get(entry.entry.instanceId)?.parkedAt != null) return { kind: "parked" };
      const until = readings.states.get(entry.key)?.cooldownUntil;
      if (until != null && until > readings.now) return { kind: "cooling", until };
      const budget = entry.entry.budget;
      if (budget !== undefined && budgetRoom(readings, entry) < budget.perRunUsd / 10) {
        return { kind: "budget", until: nextMonthStart(readings.now) };
      }
      return null;
    };

  const freesAtOf = (readings: Readings) => (entry: ChainEntry) => {
    const block = blockOf(readings)(entry);
    return block?.kind === "cooling" || block?.kind === "budget" ? block.until : null;
  };

  const labelOf = (readings: Readings) => (entry: ChainEntry) => {
    const provider = readings.providers.find(
      (candidate) => candidate.instanceId === entry.entry.instanceId,
    );
    return `${provider?.displayName ?? entry.entry.instanceId} (${entry.entry.model})`;
  };

  const turnStart: ProviderFallbackPolicyShape["turnStart"] = Effect.fn(
    "ProviderFallback.turnStart",
  )(
    function* (input) {
      const readings = yield* read(input.projectId);
      const current = findChainEntry(readings.chain, input.selection);
      if (current === undefined) return null;
      const block = blockOf(readings);
      if (block(current) === null && current.index === 0) return null;
      const ready = firstReadyEntry(readings.chain, block);
      if (ready === undefined || ready.key === current.key) return null;
      const label = labelOf(readings);
      return {
        selection: selectionFor(ready.entry, input.selection),
        from: label(current),
        to: label(ready),
      };
    },
    logged("choosing a turn's entry", null),
  );

  const onChain: ProviderFallbackPolicyShape["onChain"] = Effect.fn("ProviderFallback.onChain")(
    function* (input) {
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const chain = chainEntries(
        resolveProjectSettings(settings, input.projectId).settings.providerFallbackChain,
      );
      return findChainEntry(chain, input.selection) !== undefined;
    },
    logged("reading the chain", false),
  );

  const afterFailure: ProviderFallbackPolicyShape["afterFailure"] = Effect.fn(
    "ProviderFallback.afterFailure",
  )(
    function* (input) {
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const chain = chainEntries(
        resolveProjectSettings(settings, input.projectId).settings.providerFallbackChain,
      );
      const from = findChainEntry(chain, input.selection);
      if (from === undefined) return null;
      const now = yield* Clock.currentTimeMillis;
      const reason =
        input.reason.kind === "out_of_credit" ? "Out of credit" : "Usage limit reached";
      // Budget and refusal stops are read from the ledger and the key check, not recorded here.
      if (input.record && input.reason.kind === "out_of_credit") {
        yield* store.park({ key: from.entry.instanceId, reason, now });
      } else if (input.record && input.reason.kind === "quota") {
        yield* store.coolDown({
          key: from.key,
          until: input.reason.until,
          backoff: backoffMs,
          reason,
          now,
          runId: input.runId,
        });
      }
      yield* store.markTried({
        threadId: input.threadId,
        originRunId: input.originRunId,
        key: from.key,
        now,
      });
      const tried = yield* store.tried({
        threadId: input.threadId,
        originRunId: input.originRunId,
      });
      const readings = yield* read(input.projectId);
      const current = findChainEntry(readings.chain, input.selection) ?? from;
      return {
        plan: planChainMove({
          chain: readings.chain,
          from: current,
          block: blockOf(readings, tried),
          freesAt: freesAtOf(readings),
        }),
        label: labelOf(readings),
      } satisfies ChainMove;
    },
    logged("planning a fallback move", null),
  );

  const markTried: ProviderFallbackPolicyShape["markTried"] = Effect.fn(
    "ProviderFallback.markTried",
  )(
    function* (input) {
      yield* store.markTried({
        threadId: input.threadId,
        originRunId: input.originRunId,
        key: input.entry.key,
        now: yield* Clock.currentTimeMillis,
      });
    },
    logged("recording a tried entry", undefined),
  );

  const reserveTurn: ProviderFallbackPolicyShape["reserveTurn"] = Effect.fn(
    "ProviderFallback.reserveTurn",
  )(
    function* (input) {
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const chain = chainEntries(
        resolveProjectSettings(settings, input.projectId).settings.providerFallbackChain,
      );
      const entry = findChainEntry(chain, input.selection);
      if (entry === undefined) return null;
      const now = yield* Clock.currentTimeMillis;
      const provider = (yield* registry.getProviders).find(
        (candidate) => candidate.instanceId === entry.entry.instanceId,
      );
      if (provider !== undefined && isOpenRouterEntry(provider.driver, entry.entry.model)) {
        const check = yield* keyCheck(provider, now);
        if (!check.ok) {
          return makeProviderFailure({
            class: "provider_error",
            quota: "exhausted",
            code: REFUSED_FAILURE_CODE,
            message: check.reason,
          });
        }
      }
      const budget = entry.entry.budget;
      const monthlyUsd = monthlyBudgetFor(chain, entry.entry);
      if (budget === undefined || monthlyUsd === undefined) return null;
      const reservation = yield* store.reserve({
        id: input.runId,
        budgetKey: budgetKeyFor(entry.entry),
        month: monthOf(now),
        instanceId: entry.entry.instanceId,
        threadId: input.threadId,
        runId: input.runId,
        monthlyUsd,
        perRunUsd: budget.perRunUsd,
        now,
      });
      if (reservation !== null) return null;
      return makeProviderFailure({
        class: "usage_limit",
        quota: "exhausted",
        code: BUDGET_FAILURE_CODE,
        message: `The monthly budget for ${entry.entry.model} on ${entry.entry.instanceId} is used up.`,
        retryable: true,
        resetAt: DateTime.formatIso(DateTime.makeUnsafe(nextMonthStart(now))),
      });
    },
    // A ledger that cannot be read refuses the turn rather than spend without a cap.
    Effect.catchCause((cause) =>
      Effect.logWarning("provider fallback: reserving a budget failed", { cause }).pipe(
        Effect.as(
          makeProviderFailure({
            class: "provider_error",
            code: "budget_ledger_unavailable",
            message: "T4 could not reserve this entry's budget, so the turn did not start.",
          }),
        ),
      ),
    ),
  );

  const runCost: ProviderFallbackPolicyShape["runCost"] = Effect.fn("ProviderFallback.runCost")(
    function* (input) {
      let total = 0;
      let known = false;
      for (const turn of input.providerTurns) {
        const turnUsage = turn.turnTokenUsage;
        if (turnUsage === undefined) continue;
        if (turnUsage.reportedCostUsd !== undefined) {
          total += turnUsage.reportedCostUsd;
          known = true;
          continue;
        }
        if (Option.isNone(usage)) continue;
        const input_ = turnUsage.inputTokens ?? 0;
        const cached = turnUsage.cachedInputTokens ?? 0;
        const totals = {
          // Counted high rather than low: a cap that overestimates stops early, never late.
          uncachedInputTokens:
            Math.max(0, input_ - cached) + (turnUsage.otherUsage?.inputTokens ?? 0),
          cachedInputTokens: cached,
          cacheCreationTokens: turnUsage.cacheCreationTokens ?? 0,
          outputTokens: (turnUsage.outputTokens ?? 0) + (turnUsage.otherUsage?.outputTokens ?? 0),
          reasoningTokens: turnUsage.reasoningTokens ?? 0,
        };
        const priced =
          (yield* usage.value.priceTokens({ model: input.selection.model, totals })) ??
          (turn.model === undefined
            ? null
            : yield* usage.value.priceTokens({ model: turn.model, totals }));
        if (priced === null) return null;
        total += priced;
        known = true;
      }
      return known ? total : null;
    },
    logged("pricing a run", null),
  );

  const status: ProviderFallbackPolicyShape["status"] = Effect.fn("ProviderFallback.status")(
    function* (projectId) {
      const readings = yield* read(projectId);
      const block = blockOf(readings);
      const entries = readings.chain.map((entry): ProviderFallbackEntryStatus => {
        const blocked = block(entry);
        const budget = entry.entry.budget;
        const totals = readings.totals.get(budgetKeyFor(entry.entry));
        const state = readings.states.get(entry.key) ?? readings.states.get(entry.entry.instanceId);
        return {
          instanceId: entry.entry.instanceId,
          model: entry.entry.model,
          state: blocked === null ? "ready" : blocked.kind === "tried" ? "ready" : blocked.kind,
          until:
            blocked?.kind === "cooling" || blocked?.kind === "budget"
              ? DateTime.formatIso(DateTime.makeUnsafe(blocked.until))
              : null,
          reason: blocked?.kind === "refused" ? blocked.reason : (state?.reason ?? null),
          budget:
            budget === undefined
              ? null
              : {
                  key: budgetKeyFor(entry.entry),
                  monthlyUsd: budget.monthlyUsd,
                  spentUsd: totals?.spentUsd ?? 0,
                  reservedUsd: totals?.reservedUsd ?? 0,
                },
        };
      });
      return { entries } satisfies ProviderFallbackStatus;
    },
    Effect.orDie,
  );

  return {
    turnStart,
    onChain,
    afterFailure,
    markTried,
    reserveTurn,
    reservation: (runId) => store.reservation(runId).pipe(logged("reading a reservation", null)),
    openReservations: store.openReservations().pipe(logged("reading open reservations", [])),
    runCost,
    settle: Effect.fn("ProviderFallback.settle")(
      function* (input) {
        const reservation = yield* store.reservation(input.runId);
        if (reservation === null || reservation.chargedUsd !== null) return;
        yield* store.settle({
          id: input.runId,
          chargedUsd: input.costUsd ?? reservation.capUsd,
          now: yield* Clock.currentTimeMillis,
        });
      },
      logged("settling a run's cost", undefined),
    ),
    markBudgetStopped: Effect.fn("ProviderFallback.markBudgetStopped")(
      function* (runId) {
        yield* store.markStopped({ id: runId, now: yield* Clock.currentTimeMillis });
      },
      logged("recording a budget stop", undefined),
    ),
    completed: Effect.fn("ProviderFallback.completed")(
      function* (input) {
        yield* store.clearCooldown({
          key: entryKey(input.selection.instanceId, input.selection.model),
          startedAt: input.startedAt,
        });
      },
      logged("clearing a cool-down", undefined),
    ),
    continuationNote: Effect.fn("ProviderFallback.continuationNote")(
      function* (input) {
        const providers = yield* registry.getProviders;
        const providerOf = (instanceId: ProviderInstanceId) =>
          providers.find((provider) => provider.instanceId === instanceId);
        const from = providerOf(input.from.instanceId);
        const to = providerOf(input.to.instanceId);
        if (from === undefined || to === undefined || from.driver === to.driver) return null;
        return cutOffNote(`${from.displayName ?? from.instanceId} (${input.from.model})`);
      },
      logged("naming a moved turn's source", null),
    ),
    scheduleOutcome: Effect.fn("ProviderFallback.scheduleOutcome")(
      function* (input) {
        const now = yield* Clock.currentTimeMillis;
        const streak = yield* store.recordScheduleOutcome({ ...input, now });
        if (!input.exhausted || streak < SCHEDULE_BREAKER_STREAK) return false;
        return yield* store.tripBreaker({
          scheduleId: input.scheduleId,
          threshold: SCHEDULE_BREAKER_STREAK,
          now,
        });
      },
      logged("recording a schedule's outcome", false),
    ),
    status,
    reenable: Effect.fn("ProviderFallback.reenable")(function* (instanceId) {
      keyChecks.delete(instanceId);
      yield* store.reenable(instanceId);
    }, Effect.orDie),
  } satisfies ProviderFallbackPolicyShape;
});

export const layer = Layer.effect(ProviderFallbackPolicy, make);
