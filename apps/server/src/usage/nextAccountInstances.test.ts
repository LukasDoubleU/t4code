import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { planAccountMove } from "./nextAccountInstances.ts";

const HOUR = 3_600_000;
const inHours = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(hours * HOUR));
const environmentId = EnvironmentId.make("environment:account-move");
const claude = ProviderDriverKind.make("claudeAgent");
const cursor = ProviderDriverKind.make("cursor");

function windows(input: {
  readonly session: number;
  readonly weekly: number;
  readonly sessionResetsIn?: number;
  readonly weeklyResetsIn?: number;
}): ReadonlyArray<ServerProviderUsageWindow> {
  return [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: input.session,
      windowDurationMins: 300,
      resetsAt: inHours(input.sessionResetsIn ?? 2),
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: input.weekly,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: inHours(input.weeklyResetsIn ?? 150),
    },
  ];
}

function provider(
  instanceId: string,
  email: string,
  usageWindows: ReadonlyArray<ServerProviderUsageWindow>,
  driver = claude,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated", email },
    checkedAt: inHours(0),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: inHours(0), windows: usageWindows },
  };
}

const plan = (
  providers: ReadonlyArray<ServerProvider>,
  options: {
    readonly from?: string;
    readonly usedUpUntil?: number | null;
    readonly unusable?: ReadonlyArray<string>;
  } = {},
) =>
  planAccountMove({
    environmentId,
    providers,
    usageLimitSources: [],
    now: 0,
    selection: {
      instanceId: ProviderInstanceId.make(options.from ?? "c2"),
      model: "claude-opus-5-5",
    },
    usable: (instanceId) => !options.unusable?.includes(instanceId),
    ...(options.usedUpUntil === undefined ? {} : { usedUpUntil: options.usedUpUntil }),
  });

describe("planAccountMove", () => {
  it("moves a turn that hit its limit to the account Use next recommends", () => {
    const providers = [
      // The failure decides, even while this reading still shows room.
      provider("c2", "two@example.com", windows({ session: 10, weekly: 10 })),
      provider("c5", "five@example.com", windows({ session: 10, weekly: 10 })),
      // Most weekly quota at risk: Use next recommends it.
      provider("c3", "three@example.com", windows({ session: 10, weekly: 40, weeklyResetsIn: 24 })),
      provider(
        "codex",
        "codex@example.com",
        windows({ session: 0, weekly: 90, weeklyResetsIn: 3 }),
        ProviderDriverKind.make("codex"),
      ),
    ];
    assert.deepStrictEqual(plan(providers, { usedUpUntil: HOUR }), {
      type: "move",
      from: ProviderInstanceId.make("c2"),
      to: ProviderInstanceId.make("c3"),
      usedUpUntil: HOUR,
    });
  });

  it("does not move to another instance signed in to the same account", () => {
    const providers = [
      provider("c2", "two@example.com", windows({ session: 10, weekly: 40, weeklyResetsIn: 24 })),
      provider(
        "c2-copy",
        "two@example.com",
        windows({ session: 10, weekly: 40, weeklyResetsIn: 24 }),
      ),
      provider("c5", "five@example.com", windows({ session: 10, weekly: 10 })),
    ];
    assert.deepStrictEqual(plan(providers, { usedUpUntil: HOUR }), {
      type: "move",
      from: ProviderInstanceId.make("c2"),
      to: ProviderInstanceId.make("c5"),
      usedUpUntil: HOUR,
    });
  });

  it("moves before the turn only when the reading shows the account used up", () => {
    const others = [provider("c5", "five@example.com", windows({ session: 10, weekly: 10 }))];
    assert.deepStrictEqual(
      plan([provider("c2", "two@example.com", windows({ session: 100, weekly: 20 })), ...others]),
      {
        type: "move",
        from: ProviderInstanceId.make("c2"),
        to: ProviderInstanceId.make("c5"),
        usedUpUntil: 2 * HOUR,
      },
    );
    // Little session room left is a reason to start new work elsewhere, not to move this thread.
    assert.isNull(
      plan([provider("c2", "two@example.com", windows({ session: 90, weekly: 20 })), ...others]),
    );
  });

  it("stays when no other account is ready, naming the first account to free up", () => {
    const providers = [
      provider("c2", "two@example.com", windows({ session: 10, weekly: 10 })),
      provider("c5", "five@example.com", windows({ session: 95, weekly: 10, sessionResetsIn: 3 })),
      provider("c3", "three@example.com", windows({ session: 0, weekly: 100, weeklyResetsIn: 30 })),
    ];
    assert.deepStrictEqual(plan(providers, { usedUpUntil: 5 * HOUR }), {
      type: "stay",
      from: ProviderInstanceId.make("c2"),
      freesUp: { instanceId: ProviderInstanceId.make("c5"), at: 3 * HOUR },
    });
    assert.deepStrictEqual(plan(providers, { usedUpUntil: HOUR }), {
      type: "stay",
      from: ProviderInstanceId.make("c2"),
      freesUp: { instanceId: ProviderInstanceId.make("c2"), at: HOUR },
    });
  });

  it("leaves out accounts the thread's project turned off", () => {
    const providers = [
      provider("c2", "two@example.com", windows({ session: 10, weekly: 10 })),
      provider("c5", "five@example.com", windows({ session: 10, weekly: 10 })),
      provider("c3", "three@example.com", windows({ session: 10, weekly: 40, weeklyResetsIn: 24 })),
    ];
    assert.deepStrictEqual(plan(providers, { usedUpUntil: null, unusable: ["c3"] }), {
      type: "move",
      from: ProviderInstanceId.make("c2"),
      to: ProviderInstanceId.make("c5"),
      usedUpUntil: null,
    });
  });

  it("has nothing to plan for an unranked driver or a single account", () => {
    assert.isNull(
      plan(
        [
          provider("cursor", "a@example.com", windows({ session: 100, weekly: 10 }), cursor),
          provider("cursor-2", "b@example.com", windows({ session: 0, weekly: 0 }), cursor),
        ],
        { from: "cursor", usedUpUntil: HOUR },
      ),
    );
    assert.isNull(
      plan([provider("c2", "two@example.com", windows({ session: 100, weekly: 10 }))], {
        usedUpUntil: HOUR,
      }),
    );
  });
});
