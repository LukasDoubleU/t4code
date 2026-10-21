import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import type { NextAccountPreferences } from "./components/usage/nextAccountPreferences";
import {
  draftModelState,
  rankDraftInstances,
  recommendedDraftSelection,
  recommendedInstanceIds,
} from "./nextAccountSelection";
import { deriveProviderInstanceEntries } from "./providerInstances";

const now = Date.parse("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(now + hours * HOUR).toISOString();
const claude = ProviderDriverKind.make("claudeAgent");
const here = EnvironmentId.make("env-here");
const there = EnvironmentId.make("env-there");
const id = ProviderInstanceId.make;

const preferences: NextAccountPreferences = { minSessionPercent: 25, model: "any" };

function windows(sessionUsed: number, weeklyUsed: number, weeklyResetsInHours: number) {
  return [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: sessionUsed,
      windowDurationMins: 300,
      resetsAt: inHours(2),
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyUsed,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: inHours(weeklyResetsInHours),
    },
  ] satisfies ReadonlyArray<ServerProviderUsageWindow>;
}

function provider(
  instanceId: string,
  email: string | null,
  reading?: { readonly windows: ReadonlyArray<ServerProviderUsageWindow>; readonly at?: number },
): ServerProvider {
  return {
    instanceId: id(instanceId),
    driver: claude,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated", ...(email === null ? {} : { email }) },
    checkedAt: inHours(0),
    models: [],
    slashCommands: [],
    skills: [],
    ...(reading === undefined
      ? {}
      : { usageLimits: { checkedAt: inHours(reading.at ?? 0), windows: reading.windows } }),
  };
}

// Here: a roomy account the draft defaults to, an urgent one, and an API-key instance.
const hereProviders = [
  provider("claudeAgent", "roomy@example.com", { windows: windows(10, 10, 150) }),
  provider("claude_urgent", "urgent@example.com", { windows: windows(10, 40, 24) }),
  provider("claude_api", null),
];
// There: an account more urgent than any here, which a draft here cannot use.
const thereProviders = [
  provider("claude_far", "far@example.com", { windows: windows(10, 80, 12) }),
];

function presentations(
  environments: ReadonlyArray<readonly [EnvironmentId, ReadonlyArray<ServerProvider>]>,
) {
  return new Map(
    environments.map(([environmentId, providers]) => [
      environmentId,
      { entry: { target: { label: environmentId } }, serverConfig: { providers } },
    ]),
  );
}

const selection = (instanceId: string): ModelSelection => ({
  instanceId: id(instanceId),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
});

function choose(input: {
  readonly instanceId: string;
  readonly explicit?: boolean;
  readonly enabled?: boolean;
  readonly prompt?: string;
  readonly environments?: ReadonlyArray<readonly [EnvironmentId, ReadonlyArray<ServerProvider>]>;
}) {
  const entries = deriveProviderInstanceEntries(hereProviders);
  const ranks = rankDraftInstances({
    accounts: collectLimitAccounts(
      presentations(
        input.environments ?? [
          [here, hereProviders],
          [there, thereProviders],
        ],
      ),
    ),
    now,
    environmentId: here,
    entries,
    preferences,
  });
  return recommendedDraftSelection({
    enabled: input.enabled ?? true,
    draft: draftModelState({
      prompt: input.prompt ?? "",
      activeProvider: id(input.instanceId),
      modelSelectionByProvider: { [id(input.instanceId)]: selection(input.instanceId) },
      ...(input.explicit ? { modelSelectionExplicit: true } : {}),
    }),
    entries,
    ranks,
  });
}

describe("recommendedDraftSelection", () => {
  it("moves a new draft to the recommended account with the same model and options", () => {
    expect(choose({ instanceId: "claudeAgent" })).toEqual(selection("claude_urgent"));
  });

  it("leaves a draft already on the recommended account", () => {
    expect(choose({ instanceId: "claude_urgent" })).toBeNull();
  });

  it("follows the recommendation only while the prompt is empty", () => {
    expect(choose({ instanceId: "claudeAgent", prompt: "" })).toEqual(selection("claude_urgent"));
    expect(choose({ instanceId: "claudeAgent", prompt: "Fix the flaky test" })).toBeNull();
    // Clearing the prompt, down to stray whitespace, lets the draft follow again.
    expect(choose({ instanceId: "claudeAgent", prompt: " \n" })).toEqual(
      selection("claude_urgent"),
    );
  });

  it("keeps an account chosen by hand", () => {
    expect(choose({ instanceId: "claudeAgent", explicit: true })).toBeNull();
  });

  it("keeps today's default with the switch off", () => {
    expect(choose({ instanceId: "claudeAgent", enabled: false })).toBeNull();
  });

  it("keeps today's default without readings", () => {
    expect(choose({ instanceId: "claudeAgent", environments: [] })).toBeNull();
  });

  it("keeps an instance that has no reading, such as one billing an API key", () => {
    expect(choose({ instanceId: "claude_api" })).toBeNull();
  });

  it("counts only accounts signed in to the draft's environment", () => {
    // The far account ranks first across environments but is not signed in here.
    expect(choose({ instanceId: "claudeAgent" })?.instanceId).toBe("claude_urgent");
  });

  it("ranks an account by its freshest reading from any environment", () => {
    // The urgent account is signed in there too, where a later reading finds its session spent.
    const urgentThere = provider("claude_urgent_there", "urgent@example.com", {
      windows: windows(90, 45, 24),
      at: 0.5,
    });
    expect(
      choose({
        instanceId: "claudeAgent",
        environments: [
          [here, hereProviders],
          [there, [...thereProviders, urgentThere]],
        ],
      }),
    ).toBeNull();
    expect(
      choose({
        instanceId: "claude_urgent",
        environments: [
          [here, hereProviders],
          [there, [...thereProviders, urgentThere]],
        ],
      }),
    ).toEqual(selection("claudeAgent"));
  });
});

describe("recommendedInstanceIds", () => {
  const ranksFor = (providers: ReadonlyArray<ServerProvider>) =>
    rankDraftInstances({
      accounts: collectLimitAccounts(presentations([[here, providers]])),
      now,
      environmentId: here,
      entries: deriveProviderInstanceEntries(providers),
      preferences,
    });

  it("marks every instance of the recommended account", () => {
    const copy = provider("claude_urgent_copy", "urgent@example.com", {
      windows: windows(10, 40, 24),
    });
    expect([...recommendedInstanceIds(ranksFor([...hereProviders, copy]))]).toEqual([
      "claude_urgent",
      "claude_urgent_copy",
    ]);
  });

  it("marks nothing for a provider with one account", () => {
    expect(recommendedInstanceIds(ranksFor([hereProviders[1]!, hereProviders[2]!])).size).toBe(0);
  });
});
