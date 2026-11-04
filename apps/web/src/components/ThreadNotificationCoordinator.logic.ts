import {
  threadLatestRunIsBackground,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
}

export interface ThreadNotificationState extends ThreadNotificationObservation {
  readonly status: SidebarThreadStatus;
  /** The thread's agent asked for the user with Needs you, while its status does not. */
  readonly needsYou: boolean;
  /** The run was stopped, or the user didn't start it: only its questions and failures notify. */
  readonly quiet: boolean;
}

export function observeThreadNotification(thread: EnvironmentThreadShell): ThreadNotificationState {
  let status = resolveSidebarThreadStatus(thread);
  if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
  const statusNeedsUser =
    status === "input" ||
    status === "request" ||
    status === "approval" ||
    status === "failed" ||
    status === "limited";
  const asked = thread.attention ?? null;
  const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
  const settled = status === "ready" && thread.latestRun?.status === "completed";
  return {
    status,
    attention: statusNeedsUser
      ? `${thread.latestRun?.runId ?? ""}:${status}`
      : asked !== null
        ? `attention:${asked.requestedAt}`
        : null,
    needsYou: !statusNeedsUser && asked !== null,
    settled,
    completedAt: settled && Number.isFinite(completedAt) ? completedAt : null,
    quiet: thread.source.latestRunStopRequested === true || threadLatestRunIsBackground(thread),
  };
}

export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        // Needs you can arrive with its run's completion, and replaces that completion.
        skip(key, next.completedAt);
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      handled.set(key, at);
      notify(key, "completion");
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
    },
    clear(): void {
      handled.clear();
    },
  };
}
