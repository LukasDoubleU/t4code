import {
  isListedThreadLineage,
  type IdleCompactionMode,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { COMPACTION_SUGGESTION_MIN_TOKENS } from "@t3tools/shared/claudeCompaction";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import { contextNearLimit } from "../memory/ThreadMemory.ts";

// Claude Code's idleCompaction defaults to 200K and won't go below 100K. Below
// that a cold re-read is cheap, so compacting mostly loses context for little
// saving.
const MIN_CONTEXT_TOKENS = COMPACTION_SUGGESTION_MIN_TOKENS;
// Start this long before the cache expires: enough for the session to resume
// and send the compaction while the cache is still warm.
const LEAD_MS = 2 * 60_000;
// One more turn from here usually passes Claude's threshold, so that turn would compact anyway;
// compacting now moves the wait to while the user drafts. Above the memory reminder's 85%, so
// that reminder usually reaches the agent a turn earlier.
const NEAR_LIMIT_SHARE = 0.9;
// Lets a quick follow-up go out first and still finishes while the user drafts a longer one.
const NEAR_LIMIT_DELAY_MS = 60_000;
// A missed slot is made up only for a thread idle at most this long: an overnight sleep or a
// day's downtime, not every thread a server started after weeks would find.
export const MAKE_UP_MAX_IDLE_MS = 24 * 60 * 60_000;

export type IdleCompactionRecords = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "messages"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "turnItems"
  | "contextTransfers"
>;

/**
 * When an idle Claude thread should compact, or null: soon after its turn near Claude's threshold
 * (unless "off"), else under "beforeCacheExpires" shortly before the prompt cache (1h on
 * subscriptions, 5m on API keys) expires. With `makeUp`, a slot the server missed is due now
 * ("missedSlot"): it pays an uncached read, as the next send would have.
 */
export function idleCompactionWindow(
  {
    thread,
    runs,
    messages,
    providerThreads,
    providerTurns,
    runtimeRequests,
    turnItems,
    contextTransfers,
  }: IdleCompactionRecords,
  nowMs: number,
  mode: IdleCompactionMode,
  {
    compactNearLimit = true,
    makeUp = false,
  }: {
    /** False while something must reach the agent before a compaction near the limit. */
    readonly compactNearLimit?: boolean;
    /** The server may have missed the slot: it was asleep or stopped when the slot came. */
    readonly makeUp?: boolean;
  } = {},
): {
  readonly runId: (typeof runs)[number]["id"];
  readonly startMs: number;
  readonly reason: "nearLimit" | "beforeCacheExpires" | "missedSlot";
} | null {
  if (mode === "off") return null;
  if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
  if (thread.settledAt !== null || thread.settledOverride === "settled") return null;
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
    return null;
  if (!isListedThreadLineage(thread.lineage)) return null;
  // A removed or steered queued message leaves a cancelled run that never started.
  const latestRun = runs
    .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
    .reduce<(typeof runs)[number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
  if (latestRun?.status !== "completed" || latestRun.completedAt === null) return null;
  const message = messages.find((candidate) => candidate.id === latestRun.userMessageId);
  // Never compact a compaction, so one idle spell compacts at most once.
  if (message === undefined || message.text.trim().toLowerCase() === "/compact") return null;
  if (
    runtimeRequests.some((request) => request.status === "pending") ||
    // A pending merge-back belongs to the user's next message.
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    ) ||
    // Background work reports into the next turn; compaction would swallow it. A delegated
    // child's result arrives later as its own message, so it does not count.
    derivePendingBackgroundWork({
      latestRun,
      runs,
      providerThreads,
      turnItems: turnItems.filter(
        (item) => item.type !== "subagent" || item.origin !== "app_owned",
      ),
      activeProviderThreadId: thread.activeProviderThreadId,
    }).length > 0
  )
    return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  // The thread's current selection receives the /compact, so it must still be this Claude session.
  if (
    providerThread?.driver !== "claudeAgent" ||
    providerThread.id !== latestRun.providerThreadId ||
    providerThread.providerInstanceId !== thread.providerInstanceId ||
    latestRun.providerInstanceId !== thread.providerInstanceId
  )
    return null;
  const usages = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const usage = usages[0];
  if (usage === undefined) return null;
  // No minimum size: this close to its threshold, the next turn compacts whatever the size.
  if (compactNearLimit && contextNearLimit(usage, NEAR_LIMIT_SHARE)) {
    return {
      runId: latestRun.id,
      startMs: DateTime.toEpochMillis(latestRun.completedAt) + NEAR_LIMIT_DELAY_MS,
      reason: "nearLimit",
    };
  }
  if (mode !== "beforeCacheExpires" || usage.usedTokens < MIN_CONTEXT_TOKENS) return null;
  // A request served fully from cache creates no cache entry and reports no
  // TTL, but it still refreshes the cache. Treat it as unknown and skip.
  const expiresAt = usage.promptCacheExpiresAt;
  const endMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (!Number.isFinite(endMs)) return null;
  if (nowMs < endMs)
    return { runId: latestRun.id, startMs: endMs - LEAD_MS, reason: "beforeCacheExpires" };
  if (!makeUp || nowMs - DateTime.toEpochMillis(latestRun.completedAt) > MAKE_UP_MAX_IDLE_MS)
    return null;
  return { runId: latestRun.id, startMs: endMs - LEAD_MS, reason: "missedSlot" };
}
