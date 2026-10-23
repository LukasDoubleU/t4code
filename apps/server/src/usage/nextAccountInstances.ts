import type {
  EnvironmentId,
  ModelSelection,
  OrchestratorMcpProviderCapability,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import {
  describeNextAccount,
  NEXT_ACCOUNT_DRIVERS,
  rankEnvironmentInstances,
  rankNextAccounts,
} from "@t3tools/shared/usageNextAccount";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as UsageLimitSources from "./UsageLimitSources.ts";

type NextAccount = NonNullable<OrchestratorMcpProviderCapability["nextAccount"]>;

interface AccountReadings {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly usageLimitSources: ReadonlyArray<UsageLimitSourceSnapshot>;
}

function environmentAccounts(input: AccountReadings) {
  return collectLimitAccounts(
    new Map([
      [
        input.environmentId,
        {
          entry: { target: { label: "" } },
          serverConfig: { providers: input.providers, usageLimitSources: input.usageLimitSources },
        },
      ],
    ]),
  );
}

/**
 * Ranks this server's own accounts by the rule Usage → Limits shows under Use next, from the
 * readings it already holds. Agents choose before any client's session-room or model choice
 * applies, so the defaults rank: 25% session room, every model's allowance counted.
 */
export function rankProviderInstances(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly usageLimitSources: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly now: number;
}): ReadonlyMap<ProviderInstanceId, NextAccount> {
  const accounts = environmentAccounts(input);
  const ranks = rankEnvironmentInstances(
    accounts,
    input.environmentId,
    input.providers.map((provider) => provider.instanceId),
    { now: input.now },
  );
  return new Map(
    [...ranks].map(([instanceId, rank]) => [
      instanceId,
      {
        place: rank.place,
        recommended: rank.recommended,
        reason: describeNextAccount(rank.candidate, {
          now: input.now,
          formatTime: (at) => DateTime.formatIso(DateTime.makeUnsafe(at)),
        }),
      },
    ]),
  );
}

/** Hub readings count when the server reads hubs; without them each instance's own reading ranks. */
export const loadNextAccounts = Effect.fn("NextAccountInstances.load")(function* (
  environmentId: EnvironmentId,
  providers: ReadonlyArray<ServerProvider>,
  usageLimitSources: Option.Option<UsageLimitSources.UsageLimitSources["Service"]>,
) {
  return rankProviderInstances({
    environmentId,
    providers,
    usageLimitSources: Option.isSome(usageLimitSources)
      ? yield* usageLimitSources.value.current
      : [],
    now: yield* Clock.currentTimeMillis,
  });
});

/** Where a turn goes when its account is used up. Times are epoch milliseconds. */
export type AccountMove =
  | {
      readonly type: "move";
      readonly from: ProviderInstanceId;
      readonly to: ProviderInstanceId;
      readonly usedUpUntil: number | null;
    }
  | {
      /** No other account is ready: the turn stays, and `freesUp` names the first one back. */
      readonly type: "stay";
      readonly from: ProviderInstanceId;
      readonly freesUp: { readonly instanceId: ProviderInstanceId; readonly at: number } | null;
    };

/**
 * Picks the account a turn on `selection` moves to by the Use next rule, among the same
 * driver's other accounts the thread may use, ranked for the turn's model. `usedUpUntil` says the
 * turn's own account is used up, from its usage-limit failure; without it the account's reading
 * decides. Null means the turn has no reason or no account to move to.
 */
export function planAccountMove(
  input: AccountReadings & {
    readonly now: number;
    readonly selection: ModelSelection;
    readonly usable: (instanceId: ProviderInstanceId) => boolean;
    readonly usedUpUntil?: number | null;
  },
): AccountMove | null {
  const from = input.selection.instanceId;
  const driver = input.providers.find((provider) => provider.instanceId === from)?.driver;
  if (driver === undefined || !NEXT_ACCOUNT_DRIVERS.some((ranked) => ranked === driver)) {
    return null;
  }
  const accounts = environmentAccounts(input);
  const signedIn = (instanceId: ProviderInstanceId) => (account: (typeof accounts)[number]) =>
    account.instances.some(
      (instance) =>
        instance.environmentId === input.environmentId && instance.instanceId === instanceId,
    );
  const current = accounts.find(signedIn(from));
  let usedUpUntil = input.usedUpUntil;
  if (usedUpUntil === undefined) {
    if (current === undefined) return null;
    // Used up means a counted window shows nothing left; a short session alone stays put.
    const [reading] = rankNextAccounts([current], {
      now: input.now,
      model: input.selection.model,
      minSessionPercent: 1,
    });
    if (reading?.status.kind !== "blocked") return null;
    usedUpUntil = reading.status.until;
  }
  const candidates = input.providers
    .filter(
      (provider) =>
        provider.driver === driver &&
        provider.instanceId !== from &&
        provider.enabled &&
        provider.availability !== "unavailable" &&
        input.usable(provider.instanceId) &&
        (current === undefined || !signedIn(provider.instanceId)(current)),
    )
    .map((provider) => provider.instanceId);
  const ranks = rankEnvironmentInstances(
    accounts.filter((account) => account !== current),
    input.environmentId,
    candidates,
    { now: input.now, model: input.selection.model },
  );
  const ranked = candidates.flatMap((instanceId) => {
    const rank = ranks.get(instanceId);
    return rank === undefined ? [] : [{ instanceId, rank }];
  });
  if (ranked.length === 0) return null;
  const target = ranked.find((entry) => entry.rank.recommended);
  if (target !== undefined) {
    return { type: "move", from, to: target.instanceId, usedUpUntil };
  }
  const freesUp = [
    ...(usedUpUntil === null ? [] : [{ instanceId: from, at: usedUpUntil }]),
    ...ranked.flatMap(({ instanceId, rank }) =>
      rank.candidate.status.kind === "blocked"
        ? [{ instanceId, at: rank.candidate.status.until }]
        : [],
    ),
  ].reduce<{ readonly instanceId: ProviderInstanceId; readonly at: number } | null>(
    (first, next) => (first === null || next.at < first.at ? next : first),
    null,
  );
  return { type: "stay", from, freesUp };
}
