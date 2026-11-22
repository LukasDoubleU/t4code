import type {
  ProviderFallbackBudget,
  ProviderFallbackEntry,
  ProviderFallbackEntryStatus,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export type FallbackChain = ReadonlyArray<ProviderFallbackEntry>;

/** The server treats an instance and model as one entry, so the chain holds each once. */
export const entryKey = (entry: Pick<ProviderFallbackEntry, "instanceId" | "model">) =>
  `${entry.instanceId}|${entry.model}`;

export function moveEntry(chain: FallbackChain, index: number, offset: -1 | 1): FallbackChain {
  const target = index + offset;
  if (target < 0 || target >= chain.length) return chain;
  const next = [...chain];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export const replaceEntry = (
  chain: FallbackChain,
  index: number,
  entry: ProviderFallbackEntry,
): FallbackChain => chain.map((current, at) => (at === index ? entry : current));

export const removeEntry = (chain: FallbackChain, index: number): FallbackChain =>
  chain.filter((_, at) => at !== index);

/** Null for an empty field, undefined for text that is no positive amount. */
function parseUsd(text: string): number | null | undefined {
  const trimmed = text.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  const amount = Number(trimmed);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

const withoutBudget = ({ budget: _budget, ...entry }: ProviderFallbackEntry) => entry;

const withBudget = (entry: ProviderFallbackEntry, budget: ProviderFallbackBudget) => ({
  ...entry,
  budget,
});

/**
 * Applies one budget field. A budget needs both amounts, so the missing one takes the other's
 * value; clearing the monthly amount removes the budget. Null means the text is invalid.
 */
export function withBudgetField(
  entry: ProviderFallbackEntry,
  field: "monthlyUsd" | "perRunUsd" | "group",
  text: string,
): ProviderFallbackEntry | null {
  const budget = entry.budget;
  if (field === "group") {
    if (budget === undefined) return null;
    const { group: _group, ...rest } = budget;
    const group = text.trim();
    return withBudget(entry, group === "" ? rest : { ...rest, group });
  }
  const amount = parseUsd(text);
  if (amount === undefined) return null;
  if (field === "monthlyUsd") {
    if (amount === null) return withoutBudget(entry);
    return withBudget(entry, {
      ...budget,
      monthlyUsd: amount,
      perRunUsd: Math.min(budget?.perRunUsd ?? amount, amount),
    });
  }
  if (budget === undefined) {
    return amount === null ? entry : withBudget(entry, { monthlyUsd: amount, perRunUsd: amount });
  }
  return withBudget(entry, {
    ...budget,
    perRunUsd: Math.min(amount ?? budget.monthlyUsd, budget.monthlyUsd),
  });
}

export const formatUsd = (amount: number) => `$${amount.toFixed(2)}`;

export const statusForEntry = (
  statuses: ReadonlyArray<ProviderFallbackEntryStatus>,
  entry: ProviderFallbackEntry,
) =>
  statuses.find((status) => status.instanceId === entry.instanceId && status.model === entry.model);

export type StatusTone = "success" | "warning" | "error" | "secondary";

export function describeStatus(
  status: ProviderFallbackEntryStatus,
  formatTime: (iso: string) => string,
  resolve: MessageResolver = m,
): { readonly label: string; readonly tone: StatusTone; readonly detail: string | null } {
  const time = status.until === null ? null : formatTime(status.until);
  switch (status.state) {
    case "ready":
      return {
        label: resolve(msg("Ready", { $context: "provider status, available to use" })),
        tone: "success",
        detail: null,
      };
    case "cooling":
      return {
        label:
          time === null
            ? resolve(msg("Cooling down"))
            : resolve(msg("Cooling down until {time}", { time })),
        tone: "warning",
        detail: status.reason,
      };
    case "parked":
      return { label: resolve(msg("Parked: out of credit")), tone: "error", detail: status.reason };
    case "budget":
      return {
        label:
          time === null
            ? resolve(msg("Budget used up"))
            : resolve(msg("Budget used up until {time}", { time })),
        tone: "warning",
        detail: null,
      };
    case "unavailable":
      return {
        label: resolve(msg("Unavailable", { $context: "provider status" })),
        tone: "secondary",
        detail: resolve(msg("The provider is off, missing, or not enabled for this project.")),
      };
    case "refused":
      return {
        label: resolve(msg("Refused", { $context: "provider status, key was rejected" })),
        tone: "error",
        detail: status.reason,
      };
  }
}

export function describeBudget(
  status: ProviderFallbackEntryStatus,
  resolve: MessageResolver = m,
): string | null {
  if (status.budget === null) return null;
  const { spentUsd, reservedUsd, monthlyUsd } = status.budget;
  const spent = formatUsd(spentUsd);
  const monthly = formatUsd(monthlyUsd);
  if (reservedUsd > 0) {
    return resolve(
      msg("{spent} (+{reserved} reserved) of {monthly} this month", {
        spent,
        reserved: formatUsd(reservedUsd),
        monthly,
      }),
    );
  }
  return resolve(msg("{spent} of {monthly} this month", { spent, monthly }));
}
