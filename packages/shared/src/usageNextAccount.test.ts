import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { LimitAccount } from "./usageLimits.ts";
import {
  describeNextAccount,
  type NextAccountCandidate,
  type NextAccountOptions,
  rankNextAccounts,
  weeklyModelScopes,
} from "./usageNextAccount.ts";

const now = Date.parse("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const inHours = (hours: number) => iso(now + hours * HOUR);

function session(usedPercent: number, resetsInHours?: number): ServerProviderUsageWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    windowDurationMins: 300,
    ...(resetsInHours === undefined ? {} : { resetsAt: inHours(resetsInHours) }),
  };
}

function weekly(
  usedPercent: number,
  resetsInHours?: number,
  model?: { readonly id: string; readonly name: string },
): ServerProviderUsageWindow {
  return {
    id: model ? `seven_day_${model.id}` : "seven_day",
    kind: "weekly",
    label: model ? `Weekly · ${model.name}` : "Weekly",
    usedPercent,
    windowDurationMins: 7 * 24 * 60,
    ...(resetsInHours === undefined ? {} : { resetsAt: inHours(resetsInHours) }),
  };
}

const opus = (usedPercent: number, resetsInHours?: number) =>
  weekly(usedPercent, resetsInHours, { id: "opus", name: "Opus" });

function account(
  name: string,
  windows: readonly ServerProviderUsageWindow[],
  options: { readonly credits?: number; readonly driver?: string } = {},
): LimitAccount {
  return {
    key: `env-a:${name}`,
    driver: ProviderDriverKind.make(options.driver ?? "claudeAgent"),
    displayName: name,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: {
      checkedAt: "2026-10-21T11:55:00.000Z",
      windows,
      ...(options.credits === undefined
        ? {}
        : { resetCredits: { availableCount: options.credits } }),
    },
  };
}

const rank = (accounts: readonly LimitAccount[], options: Omit<NextAccountOptions, "now"> = {}) =>
  rankNextAccounts(accounts, { now, ...options });
const names = (ranked: readonly NextAccountCandidate[]) =>
  ranked.map((candidate) => candidate.account.displayName);
const reason = (candidate: NextAccountCandidate | undefined, minSessionPercent?: number) =>
  describeNextAccount(candidate!, {
    now,
    minSessionPercent,
    formatTime: iso,
  });

describe("rankNextAccounts", () => {
  it("ranks ready accounts by the weekly quota at risk, highest first", () => {
    const ranked = rank([
      account("fresh", [session(0), weekly(0)]),
      account("later", [session(10, 2), weekly(40, 96)]),
      account("soon", [session(10, 2), weekly(70, 24)]),
    ]);
    expect(names(ranked)).toEqual(["soon", "later", "fresh"]);
    expect(ranked.map((candidate) => candidate.status)).toEqual([
      expect.objectContaining({ kind: "ready", atRiskPerDay: 30 }),
      expect.objectContaining({ kind: "ready", atRiskPerDay: 15 }),
      expect.objectContaining({ kind: "ready", atRiskPerDay: 0 }),
    ]);
    expect(reason(ranked[0])).toBe("Weekly: 30% left, resets in 1d 0h · 30%/day at risk");
    expect(reason(ranked[2])).toBe("Weekly: not started, nothing at risk yet");
  });

  it("breaks a tie on weekly risk by session room, then by the sooner session reset", () => {
    const ranked = rank([
      account("roomy-late", [session(20, 4), weekly(10, 144)]),
      account("tight", [session(50, 3), weekly(40, 96)]),
      account("roomy-soon", [session(20, 1), weekly(70, 48)]),
    ]);
    expect(names(ranked)).toEqual(["roomy-soon", "roomy-late", "tight"]);
    expect(ranked.map((candidate) => candidate.status)).toEqual([
      expect.objectContaining({ atRiskPerDay: 15, tieBreak: "sessionReset" }),
      expect.objectContaining({ atRiskPerDay: 15, tieBreak: "sessionRoom" }),
      expect.objectContaining({ atRiskPerDay: 15, tieBreak: null }),
    ]);
    expect(reason(ranked[0])).toBe(
      "Weekly: 30% left, resets in 2d 0h · 15%/day at risk · session resets before the next",
    );
    expect(reason(ranked[1])).toBe(
      "Weekly: 90% left, resets in 6d 0h · 15%/day at risk · more session room than the next",
    );
  });

  it("compares weekly risk at the whole percent per day it shows", () => {
    // 15.4 and 14.6 both read 15%/day, so session room decides.
    const ranked = rank([
      account("higher", [session(40, 2), weekly(38.4, 96)]),
      account("roomier", [session(10, 2), weekly(41.6, 96)]),
    ]);
    expect(names(ranked)).toEqual(["roomier", "higher"]);
    expect(ranked[0]?.status).toMatchObject({ tieBreak: "sessionRoom" });
    expect(reason(ranked[1])).toBe("Weekly: 62% left, resets in 4d 0h · 15%/day at risk");
  });

  it("orders accounts that read the same by name", () => {
    const ranked = rank([
      account("b", [session(10, 2), weekly(40, 96)]),
      account("a", [session(10, 2), weekly(40, 96)]),
    ]);
    expect(names(ranked)).toEqual(["a", "b"]);
    expect(ranked[0]?.status).toMatchObject({ tieBreak: null });
  });

  it("says when weekly quota at risk is under 1% a day", () => {
    const [candidate] = rank([account("a", [session(10, 2), weekly(97, 160)])]);
    expect(reason(candidate)).toBe("Weekly: 3% left, resets in 6d 16h · under 1%/day at risk");
  });

  it.each([
    { usedPercent: 75, minSessionPercent: 25, kind: "ready" },
    { usedPercent: 75.4, minSessionPercent: 25, kind: "ready" },
    { usedPercent: 75.6, minSessionPercent: 25, kind: "blocked" },
    { usedPercent: 50, minSessionPercent: 50, kind: "ready" },
    { usedPercent: 60, minSessionPercent: 50, kind: "blocked" },
    { usedPercent: 89, minSessionPercent: 10, kind: "ready" },
    { usedPercent: 91, minSessionPercent: 10, kind: "blocked" },
  ])(
    "judges $usedPercent% session use against $minSessionPercent% room as $kind",
    ({ usedPercent, minSessionPercent, kind }) => {
      const [candidate] = rank([account("a", [session(usedPercent, 2), weekly(50, 48)])], {
        minSessionPercent,
      });
      expect(candidate?.status.kind).toBe(kind);
    },
  );

  it("needs 25% session room by default", () => {
    const [candidate] = rank([account("a", [session(88, 2), weekly(50, 48)])]);
    expect(candidate?.status).toMatchObject({ kind: "blocked", until: now + 2 * HOUR });
    expect(reason(candidate)).toBe("Session: 12% left, below 25% until 2026-10-21T14:00:00.000Z");
  });

  it.each([
    { usedPercent: 99.4, kind: "ready" },
    { usedPercent: 99.6, kind: "blocked" },
    { usedPercent: 100, kind: "blocked" },
  ])("treats a week $usedPercent% used as $kind", ({ usedPercent, kind }) => {
    const [candidate] = rank([account("a", [session(10, 2), weekly(usedPercent, 45)])]);
    expect(candidate?.status.kind).toBe(kind);
  });

  it("explains a blocked account by the window that keeps it blocked longest", () => {
    const ranked = rank([
      account("week-out", [session(100, 2), weekly(100, 45)]),
      account("session-out", [session(100, 3.5), weekly(50, 45)]),
      account("week-ends-first", [session(90, 5), weekly(100, 1)]),
      account("ready", [session(10, 2), weekly(50, 45)]),
    ]);
    expect(names(ranked)).toEqual(["ready", "session-out", "week-ends-first", "week-out"]);
    expect(ranked[1]?.status).toMatchObject({ kind: "blocked", until: now + 3.5 * HOUR });
    expect(reason(ranked[1])).toBe("Session: used up until 2026-10-21T15:30:00.000Z");
    expect(reason(ranked[2])).toBe("Session: 10% left, below 25% until 2026-10-21T17:00:00.000Z");
    expect(reason(ranked[3])).toBe("Weekly: used up until 2026-10-23T09:00:00.000Z");
  });

  it.each([
    { model: "claude-opus-5-5", window: "seven_day_opus", atRiskPerDay: 20 },
    { model: "opus", window: "seven_day_opus", atRiskPerDay: 20 },
    { model: undefined, window: "seven_day_opus", atRiskPerDay: 20 },
    { model: "claude-sonnet-5-5", window: "seven_day", atRiskPerDay: 30 },
    { model: null, window: "seven_day", atRiskPerDay: 30 },
  ])("ranks on the weekly window that limits model $model", ({ model, window, atRiskPerDay }) => {
    const [candidate] = rank([account("a", [session(10, 2), weekly(40, 48), opus(80, 24)])], {
      model,
    });
    expect(candidate?.weekly?.id).toBe(window);
    expect(candidate?.status).toMatchObject({ kind: "ready", atRiskPerDay });
  });

  it("blocks an account whose Opus week is used up only for Opus", () => {
    const accounts = [
      account("opus-out", [session(10, 2), weekly(40, 48), opus(100, 24)]),
      account("other", [session(10, 2), weekly(60, 48)]),
    ];
    const forOpus = rank(accounts, { model: "claude-opus-5-5" });
    expect(names(forOpus)).toEqual(["other", "opus-out"]);
    expect(forOpus[1]?.status).toMatchObject({ kind: "blocked", until: now + 24 * HOUR });
    expect(reason(forOpus[1])).toBe("Weekly · Opus: used up until 2026-10-22T12:00:00.000Z");
    expect(names(rank(accounts))).toEqual(["other", "opus-out"]);
    const forOthers = rank(accounts, { model: null });
    expect(names(forOthers)).toEqual(["opus-out", "other"]);
    expect(forOthers.map((candidate) => candidate.status.kind)).toEqual(["ready", "ready"]);
  });

  it("ignores a model allowance that does not count, even a stale one", () => {
    const accounts = [account("a", [session(10, 2), weekly(40, 48), opus(30, -1)])];
    expect(rank(accounts, { model: null })[0]?.status.kind).toBe("ready");
    expect(rank(accounts)[0]?.status).toMatchObject({
      kind: "unknown",
      reason: "stale",
      window: expect.objectContaining({ id: "seven_day_opus" }),
    });
  });

  it("ranks missing or stale readings last and says why", () => {
    const ranked = rank([
      account("stale-session", [session(10, -0.5), weekly(40, 48)]),
      account("no-weekly", [session(10, 2)]),
      account("ready", [session(10, 2), weekly(40, 48)]),
      account("reset-now", [session(10, 2), weekly(40, 0)]),
      account("no-reset", [session(10, 2), weekly(30)]),
      account("blocked", [session(100, 2), weekly(40, 48)]),
      account("no-session", [weekly(10, 48)]),
    ]);
    expect(names(ranked)).toEqual([
      "ready",
      "blocked",
      "no-reset",
      "no-session",
      "no-weekly",
      "reset-now",
      "stale-session",
    ]);
    expect(ranked.slice(2).map((candidate) => reason(candidate))).toEqual([
      "Weekly: no reset time reported",
      "No session window reported",
      "No weekly window reported",
      "Weekly: has reset since this reading, refresh Limits",
      "Session: has reset since this reading, refresh Limits",
    ]);
  });

  it("shows banked reset credits without ranking on them", () => {
    const ranked = rank([
      account("used-up", [session(10, 2), weekly(100, 30)], { credits: 1 }),
      account("zed", [session(10, 2), weekly(40, 96)], { credits: 3 }),
      account("amy", [session(10, 2), weekly(40, 96)]),
    ]);
    expect(names(ranked)).toEqual(["amy", "zed", "used-up"]);
    expect(ranked.map((candidate) => candidate.resetCredits)).toEqual([0, 3, 1]);
    expect(reason(ranked[1])).toBe(
      "Weekly: 60% left, resets in 4d 0h · 15%/day at risk · 3 reset credits banked",
    );
    expect(reason(ranked[2])).toBe(
      "Weekly: used up until 2026-10-22T18:00:00.000Z · 1 reset credit banked",
    );
  });

  it("reads Codex windows by kind", () => {
    const codex = (
      name: string,
      used: readonly [number, number],
      hours: readonly [number, number],
    ) =>
      account(
        name,
        [
          { ...session(used[0], hours[0]), id: "primary" },
          { ...weekly(used[1], hours[1]), id: "secondary" },
        ],
        { driver: "codex" },
      );
    const ranked = rank([codex("alpha", [20, 50], [3, 72]), codex("beta", [10, 80], [1, 24])]);
    expect(names(ranked)).toEqual(["beta", "alpha"]);
    expect(ranked[0]?.status).toMatchObject({ kind: "ready", atRiskPerDay: 20 });
  });
});

describe("weeklyModelScopes", () => {
  it("lists each model allowance once by the name its window carries", () => {
    expect(
      weeklyModelScopes([
        account("a", [session(10, 2), weekly(10, 48), opus(10, 48)]),
        account("b", [weekly(10, 48), weekly(10, 48, { id: "fable", name: "Fable" })]),
        account("c", [opus(20, 48)]),
        account("d", [{ ...weekly(10, 48), id: "secondary" }], { driver: "codex" }),
      ]),
    ).toEqual([
      { key: "fable", label: "Fable" },
      { key: "opus", label: "Opus" },
    ]);
  });
});
