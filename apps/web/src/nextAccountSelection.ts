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
import { useLayoutEffect, useRef } from "react";
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
> & {
  readonly hasPrompt: boolean;
};

/**
 * What the recommendation reads of a draft. The prompt counts only as whether it has text, so
 * typing does not re-render the chat view that holds the draft.
 */
export function draftModelState(
  draft: Pick<
    ComposerThreadDraftState,
    "prompt" | "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
  >,
): DraftModelState {
  return {
    activeProvider: draft.activeProvider,
    modelSelectionByProvider: draft.modelSelectionByProvider,
    ...(draft.modelSelectionExplicit === undefined
      ? {}
      : { modelSelectionExplicit: draft.modelSelectionExplicit }),
    hasPrompt: draft.prompt.trim().length > 0,
  };
}

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
 * What a visit to a draft compares to tell a pick by hand from the draft it opened with: the
 * shown account, its model and options, and whether the selection was picked by hand.
 */
export function draftVisitKey(draft: DraftModelState | null): string | null {
  if (draft === null) return null;
  const selection =
    draft.activeProvider === null ? null : draft.modelSelectionByProvider[draft.activeProvider];
  return JSON.stringify([draft.activeProvider, selection ?? null, draft.modelSelectionExplicit]);
}

/**
 * A pick by hand marks the selection explicit, and the mark stays across visits so a reused
 * draft keeps its model. Only a pick since the draft was opened holds its account.
 */
export function pickedSinceOpened(
  draft: DraftModelState | null,
  openedKey: string | null,
): boolean {
  return draft?.modelSelectionExplicit === true && draftVisitKey(draft) !== openedKey;
}

function defaultModel(entry: ProviderInstanceEntry): string | undefined {
  return (entry.models.find((model) => model.isDefault) ?? entry.models[0])?.slug;
}

/**
 * The draft on its provider's recommended account with the same model and options, or null to
 * leave it: only while its prompt is empty and unpicked since opening, never for an instance
 * without a reading (an API key). `explicit` carries over, so an earlier visit's pick stays.
 */
export function recommendedDraftSelection(input: {
  readonly enabled: boolean;
  readonly draft: DraftModelState | null;
  readonly pickedThisVisit: boolean;
  /** The instance the composer shows. It falls back past an unset or unusable `activeProvider`. */
  readonly composerInstanceId: ProviderInstanceId | null;
  /** What the composer starts from when the draft holds no selection for that instance. */
  readonly fallbackSelection: ModelSelection | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly ranks: ReadonlyMap<ProviderInstanceId, NextInstanceRank>;
}): { readonly selection: ModelSelection; readonly explicit: boolean } | null {
  const { draft } = input;
  if (!input.enabled || draft === null || draft.hasPrompt || input.pickedThisVisit) return null;
  const instanceId = input.composerInstanceId ?? draft.activeProvider;
  const current = instanceId === null ? undefined : input.ranks.get(instanceId);
  if (instanceId === null || current === undefined || current.recommended) return null;
  const target = input.entries.find(
    (entry) =>
      entry.driverKind === current.candidate.account.driver &&
      input.ranks.get(entry.instanceId)?.recommended === true,
  );
  if (target === undefined) return null;
  const held = draft.modelSelectionByProvider[instanceId];
  const fallbackEntry = input.entries.find(
    (entry) => entry.instanceId === input.fallbackSelection?.instanceId,
  );
  const fallback = fallbackEntry?.driverKind === target.driverKind ? input.fallbackSelection : null;
  const model = held?.model || fallback?.model || defaultModel(target);
  if (!model) return null;
  const options = held?.options ?? (fallback?.instanceId === instanceId ? fallback.options : null);
  return {
    selection: createModelSelection(target.instanceId, model, options),
    explicit: draft.modelSelectionExplicit === true,
  };
}

function useNextAccountRanks(
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
 * Puts a draft on its provider's recommended account each time it is opened with an empty
 * prompt, and keeps it there as readings change until the user types or picks by hand. Threads
 * that exist never move.
 */
export function useStartOnRecommendedAccount(input: {
  readonly draftId: DraftId | null;
  readonly environmentId: EnvironmentId | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly composerInstanceId: ProviderInstanceId | null;
  readonly fallbackSelection: ModelSelection | null;
}): void {
  const { draftId } = input;
  // The entries belong to the environment the chat view resolved, which can briefly differ from
  // the draft's while environments load.
  const draftEnvironmentId = useComposerDraftStore((state) =>
    draftId === null ? null : (state.getDraftSession(draftId)?.environmentId ?? null),
  );
  const ranks = useNextAccountRanks(
    draftEnvironmentId === input.environmentId ? draftEnvironmentId : null,
    input.entries,
  );
  const [preferences] = useNextAccountPreferences();
  const draft = useComposerDraftStore(
    useShallow((state): DraftModelState | null => {
      const current = draftId === null ? null : state.getComposerDraft(draftId);
      return current === null ? null : draftModelState(current);
    }),
  );
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const enabled = preferences.startNewThreads !== false;
  const { entries, composerInstanceId, fallbackSelection } = input;
  // What the current visit compares the draft against, kept off render: only the moves below
  // change it, besides a new visit.
  const visit = useRef<{ draftId: DraftId | null; openedKey: string | null }>({
    draftId: null,
    openedKey: null,
  });
  // Before paint, so an opened draft never shows the account it is about to leave.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the draft in the composer draft store, outside React, before paint.
  useLayoutEffect(() => {
    // A visit starts whenever the chat view shows a draft it was not showing.
    if (visit.current.draftId !== draftId) {
      visit.current = { draftId, openedKey: draftVisitKey(draft) };
    }
    if (draftId === null) return;
    const next = recommendedDraftSelection({
      enabled,
      draft,
      pickedThisVisit: pickedSinceOpened(draft, visit.current.openedKey),
      composerInstanceId,
      fallbackSelection,
      entries,
      ranks,
    });
    if (next === null) return;
    setModelSelection(draftId, next.selection, {
      replaceOptions: true,
      ...(next.explicit ? { explicit: true } : {}),
    });
    // The move is not a pick: what it wrote is what the rest of this visit compares against.
    const moved = useComposerDraftStore.getState().getComposerDraft(draftId);
    visit.current = {
      draftId,
      openedKey: draftVisitKey(moved === null ? null : draftModelState(moved)),
    };
  }, [
    draftId,
    draft,
    enabled,
    composerInstanceId,
    fallbackSelection,
    entries,
    ranks,
    setModelSelection,
  ]);
}
