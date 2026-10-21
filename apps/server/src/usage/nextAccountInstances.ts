import type {
  EnvironmentId,
  OrchestratorMcpProviderCapability,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { describeNextAccount, rankEnvironmentInstances } from "@t3tools/shared/usageNextAccount";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as UsageLimitSources from "./UsageLimitSources.ts";

type NextAccount = NonNullable<OrchestratorMcpProviderCapability["nextAccount"]>;

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
  const accounts = collectLimitAccounts(
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
