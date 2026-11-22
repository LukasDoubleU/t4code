import type { LimitAccount } from "@t3tools/shared/usageLimits";
import {
  describeNextAccount,
  NEXT_ACCOUNT_DRIVERS,
  type NextAccountCandidate,
  rankNextAccounts,
  type WeeklyModelScope,
  weeklyModelScopes,
} from "@t3tools/shared/usageNextAccount";
import { T, useGT, Var } from "gt-react";
import { useId } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  rankedModel,
  SESSION_ROOM_OPTIONS,
  useNextAccountPreferences,
} from "./nextAccountPreferences";
import { LimitWindows } from "./UsageLimits";
import { AccountAvatar, AccountName } from "./UsageLimitsPooled";

function modelChoiceLabel(
  choice: string,
  scopes: readonly WeeklyModelScope[],
  gt: ReturnType<typeof useGT>,
): string {
  if (choice === "other") return gt("For other models");
  const scope = scopes.find((candidate) => `scope:${candidate.key}` === choice);
  return scope ? gt("For {scope}", { scope: scope.label }) : gt("For any model");
}

function CandidateRow({
  candidate,
  rank,
  reason,
  where,
  now,
  pick = false,
}: {
  readonly candidate: NextAccountCandidate;
  readonly rank: number | null;
  readonly reason: string;
  readonly where: string | null;
  readonly now: number;
  readonly pick?: boolean;
}) {
  const { account, session, weekly, status } = candidate;
  const windows = [session, weekly].filter((window) => window !== null);
  return (
    <div className="grid gap-x-6 gap-y-2 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 items-center gap-2 self-start">
        {pick ? null : (
          <span className="w-4 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
            {rank}
          </span>
        )}
        <AccountAvatar account={account} />
        <span className="flex min-w-0 flex-col">
          <AccountName
            account={account}
            className={cn("truncate font-medium text-foreground", pick ? "text-base" : "text-sm")}
          />
          {where ? <span className="truncate text-xs text-muted-foreground">{where}</span> : null}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p
          className={cn(
            "text-xs",
            status.kind === "ready" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {reason}
        </p>
        {windows.length > 0 ? (
          <LimitWindows driver={account.driver} windows={windows} now={now} compact />
        ) : null}
      </div>
    </div>
  );
}

function NextAccountGroup({
  driver,
  ranked,
  showLabel,
  describe,
  where,
  now,
}: {
  readonly driver: LimitAccount["driver"];
  readonly ranked: readonly NextAccountCandidate[];
  readonly showLabel: boolean;
  readonly describe: (candidate: NextAccountCandidate) => string;
  readonly where: (candidate: NextAccountCandidate) => string | null;
  readonly now: number;
}) {
  const gt = useGT();
  const label = providerClients.get(driver)?.label ?? String(driver);
  const pick = ranked[0]?.status.kind === "ready" ? ranked[0] : null;
  const rest = pick ? ranked.slice(1) : ranked;
  const soonest = ranked.find((candidate) => candidate.status.kind === "blocked");
  return (
    <div className="flex flex-col gap-2">
      {showLabel ? (
        <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <ProviderInstanceIcon
            driverKind={driver}
            displayName={label}
            indicatorBackground="var(--background)"
            className="size-4"
            iconClassName="size-3.5 text-foreground/80"
          />
          {label}
        </h3>
      ) : null}
      <div
        role="group"
        aria-label={gt("Use next for {label}", { label })}
        className="flex flex-col gap-1 rounded-lg border border-border/60 p-3"
      >
        {pick ? (
          <CandidateRow
            candidate={pick}
            rank={1}
            reason={describe(pick)}
            where={where(pick)}
            now={now}
            pick
          />
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">
              <T>No account is ready</T>
            </p>
            <p className="text-xs text-muted-foreground">
              {soonest ? (
                <T>
                  <Var>
                    <AccountName
                      account={soonest.account}
                      className="font-medium text-foreground"
                    />
                  </Var>{" "}
                  is next. <Var>{describe(soonest)}</Var>
                </T>
              ) : (
                gt("Refresh Limits for a new reading.")
              )}
            </p>
          </>
        )}
      </div>
      {rest.length > 0 ? (
        <ol
          aria-label={
            pick ? gt("More {label} accounts", { label }) : gt("{label} accounts", { label })
          }
          className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60"
        >
          {rest.map((candidate) => (
            <li key={candidate.account.key} className="p-3">
              <CandidateRow
                candidate={candidate}
                rank={candidate.status.kind === "ready" ? ranked.indexOf(candidate) + 1 : null}
                reason={describe(candidate)}
                where={where(candidate)}
                now={now}
              />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * Says which subscription account to use next, per provider with more than one. The ranking
 * follows the limits snapshot, so it updates whenever Limits refreshes.
 */
export function UsageNextAccount({
  accounts,
  now,
}: {
  readonly accounts: readonly LimitAccount[];
  readonly now: number;
}) {
  const gt = useGT();
  const [preferences, update] = useNextAccountPreferences();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const headingId = useId();
  const startNewThreadsId = useId();
  const groups = NEXT_ACCOUNT_DRIVERS.flatMap((kind) => {
    const members = accounts.filter((account) => account.driver === kind);
    const driver = members[0]?.driver;
    return driver && members.length > 1 ? [{ driver, members }] : [];
  });
  if (groups.length === 0) return null;

  const listed = groups.flatMap((group) => group.members);
  const scopes = weeklyModelScopes(listed);
  const model = rankedModel(preferences.model, scopes);
  const modelChoice = model === undefined ? "any" : model === null ? "other" : `scope:${model}`;
  const options = { now, minSessionPercent: preferences.minSessionPercent, model };
  const describe = (candidate: NextAccountCandidate) =>
    describeNextAccount(candidate, {
      ...options,
      formatTime: (at) => formatUpcomingTimestamp(new Date(at).toISOString(), timestampFormat, now),
    });
  // Where an account is signed in only tells accounts apart across environments or hubs.
  const showWhere =
    new Set(listed.flatMap((account) => account.environments.map((entry) => entry.environmentId)))
      .size > 1 || listed.some((account) => account.sourceLabel !== null);
  const where = ({ account }: NextAccountCandidate) => {
    if (!showWhere) return null;
    if (account.environments.length > 0) {
      return account.environments.map((entry) => entry.label).join(", ");
    }
    return account.sourceLabel ? gt("Via {source}", { source: account.sourceLabel }) : null;
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-sm font-medium text-foreground">
          <T>Use next</T>
        </h2>
        <div className="ms-auto flex flex-wrap items-center justify-end gap-1">
          <label
            htmlFor={startNewThreadsId}
            className="flex cursor-pointer items-center gap-1.5 px-2 text-xs text-muted-foreground"
          >
            <Switch
              id={startNewThreadsId}
              size="sm"
              checked={preferences.startNewThreads !== false}
              aria-label={gt("Start new threads on the recommended account")}
              onCheckedChange={(checked) => update({ startNewThreads: checked })}
            />
            <T>Start new threads on the recommended account</T>
          </label>
          <Select
            value={String(preferences.minSessionPercent)}
            onValueChange={(value) => {
              const minSessionPercent = SESSION_ROOM_OPTIONS.find(
                (percent) => String(percent) === value,
              );
              if (minSessionPercent) update({ minSessionPercent });
            }}
          >
            <SelectTrigger
              aria-label={gt("Session room needed")}
              size="compact"
              variant="ghost"
              className="w-auto min-w-0"
            >
              <SelectValue>
                {gt("Needs {percent}% session", { percent: preferences.minSessionPercent })}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {SESSION_ROOM_OPTIONS.map((percent) => (
                <SelectItem key={percent} value={String(percent)}>
                  {gt("Needs {percent}% session", { percent })}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {scopes.length > 0 ? (
            <Select
              value={modelChoice}
              onValueChange={(value) => {
                if (typeof value === "string") update({ model: value });
              }}
            >
              <SelectTrigger
                aria-label={gt("Model to rank for")}
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>{modelChoiceLabel(modelChoice, scopes, gt)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {["any", ...scopes.map((scope) => `scope:${scope.key}`), "other"].map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {modelChoiceLabel(choice, scopes, gt)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
      </div>
      {groups.map((group) => (
        <NextAccountGroup
          key={group.driver}
          driver={group.driver}
          ranked={rankNextAccounts(group.members, options)}
          showLabel={groups.length > 1}
          describe={describe}
          where={where}
          now={now}
        />
      ))}
    </section>
  );
}
