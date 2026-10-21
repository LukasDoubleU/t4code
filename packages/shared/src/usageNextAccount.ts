import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

import { formatDuration, type LimitAccount, remainingPercent } from "./usageLimits.ts";

const DAY = 24 * 60 * 60_000;

export const DEFAULT_MIN_SESSION_PERCENT = 25;

/**
 * Drivers whose accounts report the one session window and the weekly windows the ranking reads.
 * Antigravity reports a session window per model family, which has no single answer.
 */
export const NEXT_ACCOUNT_DRIVERS = ["claudeAgent", "codex"] as const;

// Claude reports a model's own weekly allowance as `seven_day_<model>`, beside the `seven_day`
// window every model draws on.
const MODEL_WEEKLY_ID = /^seven_day_([a-z0-9_]+)$/;

type Window = ServerProviderUsageWindow;

/** Each status names the window it is about. */
export type NextAccountStatus =
  | {
      readonly kind: "ready";
      /** The weekly window that limits the model. */
      readonly window: Window;
      /** Percent of that window that expires unused per day until it resets. */
      readonly atRiskPerDay: number;
      /** What puts the account ahead of the next ready one when their weekly risk reads the same. */
      readonly tieBreak: "sessionRoom" | "sessionReset" | null;
    }
  | {
      readonly kind: "blocked";
      /** The window that keeps the account blocked longest. */
      readonly window: Window;
      readonly until: number;
    }
  | {
      readonly kind: "unknown";
      readonly reason: "noSession" | "noWeekly" | "stale" | "noReset";
      readonly window: Window | null;
    };

export interface NextAccountCandidate {
  readonly account: LimitAccount;
  readonly session: Window | null;
  /** The counted weekly window with the least left: the one that limits the model. */
  readonly weekly: Window | null;
  /** Shown, not ranked: redeeming one makes a blocked account usable again. */
  readonly resetCredits: number;
  readonly status: NextAccountStatus;
}

export interface NextAccountOptions {
  readonly now: number;
  /** Whole percent of the session window an account needs left to be ready. */
  readonly minSessionPercent?: number | undefined;
  /**
   * The model the next thread runs, as an id (`claude-opus-5-5`) or a scope (`opus`): its own
   * weekly allowance counts beside the overall one. `null` is a model without its own allowance.
   * Unset, every model's allowance counts, so none can stop the recommended account.
   */
  readonly model?: string | null | undefined;
}

export interface WeeklyModelScope {
  readonly key: string;
  readonly label: string;
}

type Ready = NextAccountCandidate & {
  readonly session: Window;
  readonly status: Extract<NextAccountStatus, { kind: "ready" }>;
};
type Blocked = NextAccountCandidate & {
  readonly status: Extract<NextAccountStatus, { kind: "blocked" }>;
};

function resetAt(window: Window): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

// A window that has not started has no reset, and sorts after every started one.
const resetOrder = (window: Window) => resetAt(window) ?? Number.POSITIVE_INFINITY;

function weeklyModelScope(window: Window): string | null {
  return window.kind === "weekly" ? (MODEL_WEEKLY_ID.exec(window.id)?.[1] ?? null) : null;
}

const words = (value: string) =>
  ` ${value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ")} `;

function scopeCounts(scope: string, model: string | null | undefined): boolean {
  if (model === undefined) return true;
  return model !== null && words(model).includes(words(scope));
}

/** The model-scoped weekly allowances the accounts report, to choose the model to rank for. */
export function weeklyModelScopes(accounts: readonly LimitAccount[]): readonly WeeklyModelScope[] {
  const scopes = new Map<string, string>();
  for (const account of accounts) {
    for (const window of account.limits.windows) {
      const key = weeklyModelScope(window);
      if (key === null || scopes.has(key)) continue;
      const separator = window.label.lastIndexOf(" · ");
      scopes.set(key, separator < 0 ? key : window.label.slice(separator + 3));
    }
  }
  return [...scopes]
    .map(([key, label]) => ({ key, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function accountName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

function byName(left: NextAccountCandidate, right: NextAccountCandidate): number {
  return (
    accountName(left.account).localeCompare(accountName(right.account)) ||
    left.account.key.localeCompare(right.account.key)
  );
}

function evaluate(
  account: LimitAccount,
  now: number,
  minSessionPercent: number,
  model: string | null | undefined,
): NextAccountCandidate {
  const session = account.limits.windows.find((window) => window.kind === "session") ?? null;
  const weeklies = account.limits.windows.filter((window) => {
    if (window.kind !== "weekly") return false;
    const scope = weeklyModelScope(window);
    return scope === null || scopeCounts(scope, model);
  });
  // Of equally full windows, quota expires first from the one that resets first.
  const weekly =
    [...weeklies].sort(
      (left, right) =>
        remainingPercent(left) - remainingPercent(right) || resetOrder(left) - resetOrder(right),
    )[0] ?? null;
  const candidate = {
    account,
    session,
    weekly,
    resetCredits: account.limits.resetCredits?.availableCount ?? 0,
  };
  const unknown = (
    reason: Extract<NextAccountStatus, { kind: "unknown" }>["reason"],
    window: Window | null,
  ): NextAccountCandidate => ({ ...candidate, status: { kind: "unknown", reason, window } });

  if (session === null) return unknown("noSession", null);
  if (weekly === null) return unknown("noWeekly", null);
  const counted = [session, ...weeklies];
  // A reset at or before now means the reading predates it, so its numbers no longer hold.
  const stale = counted.find((window) => resetOrder(window) <= now);
  if (stale) return unknown("stale", stale);
  // A window that has not started reports no reset and nothing used: it is all room.
  const unclocked = counted.find((window) => resetAt(window) === null && window.usedPercent > 0);
  if (unclocked) return unknown("noReset", unclocked);

  // Blocking windows have been used, so each has a reset time by now.
  const latest = [
    ...(remainingPercent(session) < minSessionPercent ? [session] : []),
    ...weeklies.filter((window) => remainingPercent(window) <= 0),
  ].sort((left, right) => resetOrder(right) - resetOrder(left))[0];
  if (latest) {
    return {
      ...candidate,
      status: { kind: "blocked", window: latest, until: resetOrder(latest) },
    };
  }
  const weeklyReset = resetAt(weekly);
  return {
    ...candidate,
    status: {
      kind: "ready",
      window: weekly,
      // Nothing expires from a week that has not started; using the account starts it.
      atRiskPerDay:
        weeklyReset === null
          ? 0
          : (100 - Math.max(0, Math.min(100, weekly.usedPercent))) / ((weeklyReset - now) / DAY),
      tieBreak: null,
    },
  };
}

// Risk compares at the whole percent per day the view shows, so accounts that read the same
// fall through to the session tie-breaks instead of a difference nobody can see.
const shownRisk = (candidate: Ready) => Math.round(candidate.status.atRiskPerDay);

function compareReady(left: Ready, right: Ready): number {
  return (
    shownRisk(right) - shownRisk(left) ||
    remainingPercent(right.session) - remainingPercent(left.session) ||
    resetOrder(left.session) - resetOrder(right.session) ||
    byName(left, right)
  );
}

function tieBreak(ahead: Ready, behind: Ready | undefined): Ready["status"]["tieBreak"] {
  if (!behind || shownRisk(ahead) !== shownRisk(behind)) return null;
  if (remainingPercent(ahead.session) > remainingPercent(behind.session)) return "sessionRoom";
  return resetOrder(ahead.session) < resetOrder(behind.session) ? "sessionReset" : null;
}

/**
 * Orders one provider's accounts by which to use next. Ready accounts have enough session room
 * and weekly quota left; they come first, the most weekly quota at risk of expiring unused
 * first. Blocked accounts follow, the soonest ready again first. Accounts whose limits are
 * missing or out of date come last.
 */
export function rankNextAccounts(
  accounts: readonly LimitAccount[],
  options: NextAccountOptions,
): readonly NextAccountCandidate[] {
  const minSessionPercent = Math.max(
    0,
    Math.min(100, options.minSessionPercent ?? DEFAULT_MIN_SESSION_PERCENT),
  );
  const candidates = accounts.map((account) =>
    evaluate(account, options.now, minSessionPercent, options.model),
  );
  const ready = candidates
    .filter((candidate): candidate is Ready => candidate.status.kind === "ready")
    .sort(compareReady);
  const blocked = candidates
    .filter((candidate): candidate is Blocked => candidate.status.kind === "blocked")
    .sort((left, right) => left.status.until - right.status.until || byName(left, right));
  const unknown = candidates
    .filter((candidate) => candidate.status.kind === "unknown")
    .sort(byName);
  return [
    ...ready.map((candidate, index) => ({
      ...candidate,
      status: { ...candidate.status, tieBreak: tieBreak(candidate, ready[index + 1]) },
    })),
    ...blocked,
    ...unknown,
  ];
}

export interface NextInstanceRank {
  /** Starts at 1, among the environment's accounts of the instance's driver. */
  readonly place: number;
  /** The account to start new work on: the first one, when it is ready. */
  readonly recommended: boolean;
  readonly candidate: NextAccountCandidate;
}

/**
 * Ranks the accounts behind one environment's provider instances. Pooled readings count an
 * account once however many environments sign it in, so only accounts signed in to one of
 * `instanceIds` in that environment take part, and every such instance shares its account's place.
 */
export function rankEnvironmentInstances(
  accounts: readonly LimitAccount[],
  environmentId: EnvironmentId,
  instanceIds: Iterable<ProviderInstanceId>,
  options: NextAccountOptions,
): ReadonlyMap<ProviderInstanceId, NextInstanceRank> {
  const eligible = new Set(instanceIds);
  const instancesHere = (account: LimitAccount) =>
    account.instances.flatMap((instance) =>
      instance.environmentId === environmentId && eligible.has(instance.instanceId)
        ? [instance.instanceId]
        : [],
    );
  const ranks = new Map<ProviderInstanceId, NextInstanceRank>();
  for (const driver of NEXT_ACCOUNT_DRIVERS) {
    const members = accounts.filter(
      (account) => account.driver === driver && instancesHere(account).length > 0,
    );
    rankNextAccounts(members, options).forEach((candidate, index) => {
      const recommended = index === 0 && candidate.status.kind === "ready";
      for (const instanceId of instancesHere(candidate.account)) {
        ranks.set(instanceId, { place: index + 1, recommended, candidate });
      }
    });
  }
  return ranks;
}

function formatRisk(perDay: number): string {
  const shown = Math.round(perDay);
  return shown === 0 ? "under 1%/day" : `${shown}%/day`;
}

const TIE_BREAK_TEXT = {
  sessionRoom: " · more session room than the next",
  sessionReset: " · session resets before the next",
} as const;

/** Why the account sits where it does, in one line. `formatTime` renders a reset time. */
export function describeNextAccount(
  candidate: NextAccountCandidate,
  options: {
    readonly now: number;
    readonly minSessionPercent?: number | undefined;
    readonly formatTime: (at: number) => string;
  },
): string {
  const credits = candidate.resetCredits;
  const banked =
    credits > 0 ? ` · ${credits} reset ${credits === 1 ? "credit" : "credits"} banked` : "";
  const { status } = candidate;
  switch (status.kind) {
    case "ready": {
      const { window } = status;
      const at = resetAt(window);
      const risk =
        at === null
          ? `${window.label}: not started, nothing at risk yet`
          : `${window.label}: ${remainingPercent(window)}% left, resets in ${formatDuration(at - options.now)} · ${formatRisk(status.atRiskPerDay)} at risk`;
      return `${risk}${status.tieBreak ? TIE_BREAK_TEXT[status.tieBreak] : ""}${banked}`;
    }
    case "blocked": {
      const left = remainingPercent(status.window);
      const until = options.formatTime(status.until);
      return left <= 0
        ? `${status.window.label}: used up until ${until}${banked}`
        : `${status.window.label}: ${left}% left, below ${options.minSessionPercent ?? DEFAULT_MIN_SESSION_PERCENT}% until ${until}${banked}`;
    }
    case "unknown": {
      if (status.window === null) {
        return `No ${status.reason === "noSession" ? "session" : "weekly"} window reported${banked}`;
      }
      return status.reason === "stale"
        ? `${status.window.label}: has reset since this reading, refresh Limits${banked}`
        : `${status.window.label}: no reset time reported${banked}`;
    }
  }
}
