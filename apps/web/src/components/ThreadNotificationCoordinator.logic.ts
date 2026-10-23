import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadLatestRunIsBackground } from "@t3tools/client-runtime/state/models";

import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";

/** What a thread last notified about, so each question, failure and completion notifies once. */
export interface ThreadNotificationMarks {
  readonly attention: string | null;
  readonly completion: number | null;
}

interface ThreadNotificationDecision {
  readonly marks: ThreadNotificationMarks;
  readonly status: SidebarThreadStatus;
  /** `attention`: the thread's agent asked for the user, and notifies as a question does. */
  readonly kind: "input" | "attention" | "completion" | null;
}

export function decideThreadNotification(
  thread: EnvironmentThreadShell,
  prior: ThreadNotificationMarks | undefined,
): ThreadNotificationDecision {
  let status = resolveSidebarThreadStatus(thread);
  if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
  const statusNeedsUser =
    status === "input" || status === "approval" || status === "failed" || status === "limited";
  const attention = statusNeedsUser
    ? `${thread.latestRun?.runId ?? ""}:${status}`
    : thread.attention != null
      ? `attention:${thread.attention.requestedAt}`
      : null;
  const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
  const completion =
    status === "ready" && thread.latestRun?.status === "completed" && Number.isFinite(completedAt)
      ? completedAt
      : (prior?.completion ?? null);
  const marks = { attention, completion };
  if (!prior || thread.archivedAt !== null) return { marks, status, kind: null };
  const kind =
    attention && attention !== prior.attention
      ? statusNeedsUser
        ? "input"
        : "attention"
      : completion !== null &&
          (prior.completion === null || completion > prior.completion) &&
          // The user didn't start this turn, so only its questions and failures reach them.
          !threadLatestRunIsBackground(thread)
        ? "completion"
        : null;
  return { marks, status, kind };
}
