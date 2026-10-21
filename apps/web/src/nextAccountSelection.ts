import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { collectLimitAccounts, type LimitAccount } from "@t3tools/shared/usageLimits";
import {
  type NextInstanceRank,
  rankEnvironmentInstances,
  weeklyModelScopes,
} from "@t3tools/shared/usageNextAccount";
import { Atom } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  type NextAccountPreferences,
  rankedModel,
  useNextAccountPreferences,
} from "./components/usage/nextAccountPreferences";
import {
  type ComposerThreadDraftState,
  type DraftId,
  useComposerDraftStore,
} from "./composerDraftStore";
import type { ProviderInstanceEntry } from "./providerInstances";
import { environmentPresentations } from "./state/presentation";

type DraftModelState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

const NO_RANKS: ReadonlyMap<ProviderInstanceId, NextInstanceRank> = new Map();

// Pooled like Usage → Limits. The ranking runs at the time the readings arrived, so it holds
// still between readings instead of needing a ticking clock.
const nextAccountReadingsAtom = Atom.make((get) => ({
  accounts: collectLimitAccounts(get(environmentPresentations.presentationsWithProvidersAtom)),
  now: Date.now(),
})).pipe(Atom.withLabel("next-account-readings"));

/** Ranks the accounts behind one environment's usable instances, as the Use next card does. */
export function rankDraftInstances(input: {
  readonly accounts: readonly LimitAccount[];
  readonly now: number;
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly preferences: NextAccountPreferences;
}): ReadonlyMap<ProviderInstanceId, NextInstanceRank> {
  return rankEnvironmentInstances(
    input.accounts,
    input.environmentId,
    input.entries
      .filter((entry) => entry.enabled && entry.isAvailable)
      .map((entry) => entry.instanceId),
    {
      now: input.now,
      minSessionPercent: input.preferences.minSessionPercent,
      model: rankedModel(input.preferences.model, weeklyModelScopes(input.accounts)),
    },
  );
}

/**
 * The selection that moves a draft to the recommended account of its provider, with the same
 * model and options, or null to leave it. A choice made by hand stays, and so does an instance
 * without a reading, such as one that bills an API key.
 */
export function recommendedDraftSelection(input: {
  readonly enabled: boolean;
  readonly draft: DraftModelState | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly ranks: ReadonlyMap<ProviderInstanceId, NextInstanceRank>;
}): ModelSelection | null {
  const { draft } = input;
  if (!input.enabled || draft === null || draft.modelSelectionExplicit === true) return null;
  if (draft.activeProvider === null) return null;
  const selection = draft.modelSelectionByProvider[draft.activeProvider];
  const current = input.ranks.get(draft.activeProvider);
  if (selection === undefined || current === undefined || current.recommended) return null;
  const target = input.entries.find(
    (entry) =>
      entry.driverKind === current.candidate.account.driver &&
      input.ranks.get(entry.instanceId)?.recommended === true,
  );
  return target
    ? createModelSelection(target.instanceId, selection.model, selection.options)
    : null;
}

export function useNextAccountRanks(
  environmentId: EnvironmentId | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyMap<ProviderInstanceId, NextInstanceRank> {
  const readings = useAtomValue(nextAccountReadingsAtom);
  const [preferences] = useNextAccountPreferences();
  if (environmentId === null) return NO_RANKS;
  return rankDraftInstances({ ...readings, environmentId, entries, preferences });
}

/**
 * The instances the model picker marks as the account to use next. Like the Use next card, it
 * marks nothing for a provider with a single account: there is no choice to point at.
 */
export function recommendedInstanceIds(
  ranks: ReadonlyMap<ProviderInstanceId, NextInstanceRank>,
): ReadonlySet<ProviderInstanceId> {
  const accountsByDriver = new Map<string, Set<string>>();
  for (const { candidate } of ranks.values()) {
    const { driver, key } = candidate.account;
    accountsByDriver.set(driver, (accountsByDriver.get(driver) ?? new Set()).add(key));
  }
  return new Set(
    [...ranks].flatMap(([instanceId, rank]) =>
      rank.recommended && (accountsByDriver.get(rank.candidate.account.driver)?.size ?? 0) > 1
        ? [instanceId]
        : [],
    ),
  );
}

export function useRecommendedInstanceIds(
  environmentId: EnvironmentId | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlySet<ProviderInstanceId> {
  return recommendedInstanceIds(useNextAccountRanks(environmentId, entries));
}

/**
 * Keeps a draft on its provider's recommended account until the user picks an account by hand.
 * Readings that change while the draft waits move it along; threads that exist never move.
 */
export function useStartOnRecommendedAccount(input: {
  readonly draftId: DraftId | null;
  readonly environmentId: EnvironmentId | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
}): void {
  const { draftId } = input;
  const ranks = useNextAccountRanks(input.environmentId, input.entries);
  const [preferences] = useNextAccountPreferences();
  const draft = useComposerDraftStore(
    useShallow((state): DraftModelState | null => {
      const current = draftId === null ? null : state.getComposerDraft(draftId);
      return current === null
        ? null
        : {
            activeProvider: current.activeProvider,
            modelSelectionByProvider: current.modelSelectionByProvider,
            ...(current.modelSelectionExplicit === undefined
              ? {}
              : { modelSelectionExplicit: current.modelSelectionExplicit }),
          };
    }),
  );
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const next = recommendedDraftSelection({
    enabled: preferences.startNewThreads !== false,
    draft,
    entries: input.entries,
    ranks,
  });
  // Before paint, so a new draft never shows the account it is about to leave.
  useLayoutEffect(() => {
    if (draftId !== null && next !== null) {
      setModelSelection(draftId, next, { replaceOptions: true });
    }
  }, [draftId, next, setModelSelection]);
}
