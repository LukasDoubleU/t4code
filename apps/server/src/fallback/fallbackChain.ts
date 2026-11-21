import type {
  ModelSelection,
  OrchestrationV2ProviderFailure,
  ProviderFallbackEntry,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { entryKey } from "./ProviderFallbackStore.ts";

const MINUTE = 60_000;
/** Cool-down without a reset time: 10 minutes, doubling per failure in a row, at most 6 hours. */
export const BACKOFF_BASE_MS = 10 * MINUTE;
export const BACKOFF_CAP_MS = 6 * 60 * MINUTE;
/** A schedule that exhausts the chain this many runs in a row pauses itself. */
export const SCHEDULE_BREAKER_STREAK = 3;
/** Set by T4 itself when an entry's own budget refuses a turn; a structured signal like any other. */
export const BUDGET_FAILURE_CODE = "budget_exhausted";

export const backoffMs = (failures: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));

/** Why an entry cannot take a turn right now. */
export type EntryBlock =
  | { readonly kind: "tried" }
  | { readonly kind: "cooling"; readonly until: number }
  | { readonly kind: "parked" }
  | { readonly kind: "budget"; readonly until: number }
  | { readonly kind: "unavailable" }
  | { readonly kind: "refused"; readonly reason: string };

export interface ChainEntry {
  readonly index: number;
  readonly entry: ProviderFallbackEntry;
  readonly key: string;
}

export const chainEntries = (
  chain: ReadonlyArray<ProviderFallbackEntry>,
): ReadonlyArray<ChainEntry> =>
  chain.map((entry, index) => ({ index, entry, key: entryKey(entry.instanceId, entry.model) }));

/** The entry a selection runs on: its instance and model, else the first entry on its instance. */
export function findChainEntry(
  chain: ReadonlyArray<ChainEntry>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): ChainEntry | undefined {
  return (
    chain.find(
      ({ entry }) => entry.instanceId === selection.instanceId && entry.model === selection.model,
    ) ?? chain.find(({ entry }) => entry.instanceId === selection.instanceId)
  );
}

export const selectionFor = (entry: ProviderFallbackEntry): ModelSelection => ({
  instanceId: entry.instanceId,
  model: entry.model,
});

/** The failures that move a thread along its chain: only a structured quota or budget signal. */
export const isChainTrigger = (failure: OrchestrationV2ProviderFailure | null | undefined) =>
  failure != null && failure.quota !== undefined;

export type ChainPlan =
  | { readonly type: "move"; readonly from: ChainEntry; readonly to: ChainEntry }
  | {
      readonly type: "exhausted";
      readonly from: ChainEntry;
      /** The entry that frees up first, when one has a known time. */
      readonly freesUp: { readonly entry: ChainEntry; readonly at: number } | null;
    };

/** The first entry from the top that may take the turn; earlier entries win once they reset. */
export function firstReadyEntry(
  chain: ReadonlyArray<ChainEntry>,
  block: (entry: ChainEntry) => EntryBlock | null,
): ChainEntry | undefined {
  return chain.find((entry) => block(entry) === null);
}

export function planChainMove(input: {
  readonly chain: ReadonlyArray<ChainEntry>;
  readonly from: ChainEntry;
  readonly block: (entry: ChainEntry) => EntryBlock | null;
  /** When an entry can take turns again, if known: its cool-down's end or its budget's month. */
  readonly freesAt: (entry: ChainEntry) => number | null;
}): ChainPlan {
  const to = input.chain.find(
    (entry) => entry.key !== input.from.key && input.block(entry) === null,
  );
  if (to !== undefined) return { type: "move", from: input.from, to };
  let freesUp: { readonly entry: ChainEntry; readonly at: number } | null = null;
  for (const entry of input.chain) {
    const at = input.freesAt(entry);
    if (at !== null && (freesUp === null || at < freesUp.at)) freesUp = { entry, at };
  }
  return { type: "exhausted", from: input.from, freesUp };
}

/** The first day of the next UTC month, when monthly budgets start again. */
export function nextMonthStart(now: number): number {
  const monthStart = DateTime.startOf(DateTime.makeUnsafe(now), "month");
  return DateTime.toEpochMillis(DateTime.add(monthStart, { months: 1 }));
}

export const monthOf = (now: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(now)).slice(0, 7);

export const budgetKeyFor = (entry: ProviderFallbackEntry): string =>
  entry.budget?.group === undefined
    ? `instance:${entry.instanceId}`
    : `group:${entry.budget.group}`;

export type TriggerReason =
  | { readonly kind: "quota"; readonly until: number | null }
  | { readonly kind: "out_of_credit" }
  | { readonly kind: "budget" };

function reasonText(reason: TriggerReason, time: (at: number) => string): string {
  switch (reason.kind) {
    case "quota":
      return reason.until === null
        ? "its usage limit is reached"
        : `its usage limit is reached until ${time(reason.until)}`;
    case "out_of_credit":
      return "it is out of credit; re-enable it in Settings once it has credit again";
    case "budget":
      return "its budget is used up";
  }
}

export function chainNotice(
  plan: ChainPlan,
  options: {
    readonly reason: TriggerReason;
    readonly label: (entry: ChainEntry) => string;
    readonly time: (at: number) => string;
  },
): string {
  const from = options.label(plan.from);
  const why = reasonText(options.reason, options.time);
  if (plan.type === "move") {
    return `Fallback chain: moved from ${from} to ${options.label(plan.to)}: ${why}.`;
  }
  const next =
    plan.freesUp === null
      ? ""
      : ` ${options.label(plan.freesUp.entry)} frees up first, at ${options.time(plan.freesUp.at)}.`;
  return `Fallback chain: no entry is ready after ${from}: ${why}.${next}`;
}

/** The first line a moved turn's new provider reads, before the thread's handoff summary. */
export const cutOffNote = (from: string) =>
  `Your previous attempt at this turn was cut off on ${from} because it reached its usage limit or budget. This is a new session that continues the same thread; check the current state before you repeat any action that changes it.`;
