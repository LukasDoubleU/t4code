import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";

/** What a thread last notified about, so each question, failure and completion notifies once. */
export interface ThreadNotificationMarks {
  readonly attention: string | null;
  readonly completion: number | null;
}

interface ThreadNotificationDecision {
  readonly marks: ThreadNotificationMarks;
  readonly status: SidebarThreadStatus;
  readonly kind: "input" | "completion" | null;
}

export function decideThreadNotification(
  thread: EnvironmentThreadShell,
  prior: ThreadNotificationMarks | undefined,
): ThreadNotificationDecision {
  let status = resolveSidebarThreadStatus(thread);
  if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
  const attention =
    status === "input" || status === "approval" || status === "failed" || status === "limited"
      ? `${thread.latestRun?.runId ?? ""}:${status}`
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
      ? "input"
      : completion !== null &&
          (prior.completion === null || completion > prior.completion) &&
          // The user didn't ask for this turn, so only its questions and failures reach them.
          thread.source.latestRunFromAnotherAgent !== true
        ? "completion"
        : null;
  return { marks, status, kind };
}
