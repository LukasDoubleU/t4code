import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type {
  EnvironmentId,
  OrchestrationV2ThreadTailMessage,
  ServerConfig,
} from "@t3tools/contracts";

import { filterSidebarV2VisibleThreads, resolveSidebarThreadSection } from "../Sidebar.logic";

export function expertKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/** The threads the sidebar's Experts section lists, of every connected environment. */
export function selectFeedExperts<T extends EnvironmentThreadShell>(input: {
  readonly threads: readonly T[];
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "environment">>;
  readonly now?: string;
}): T[] {
  const now = input.now ?? new Date().toISOString();
  return filterSidebarV2VisibleThreads(input.threads, null, input.delegatedUnderParent).filter(
    (thread) => {
      const capabilities = input.serverConfigs.get(thread.environmentId)?.environment.capabilities;
      return (
        resolveSidebarThreadSection({
          snoozed: capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now }),
          settled: capabilities?.threadSettlement === true && thread.settledOverride === "settled",
          pinned: thread.pinnedAt != null,
        }) === "pinned"
      );
    },
  );
}

/**
 * Changes when an expert's tail may have: a run starts or ends, a message reaches it, or it
 * asks for input or approval. Its other shell updates, streaming ones above all, keep it.
 */
export function threadTailRefreshKey(
  shell: Pick<
    EnvironmentThreadShell,
    "latestRun" | "runtime" | "latestUserMessageAt" | "hasPendingUserInput" | "hasPendingApprovals"
  > | null,
): string {
  if (shell === null) return "";
  return [
    shell.latestRun?.runId ?? "",
    threadRuntimeIsActive(shell.runtime),
    shell.latestUserMessageAt ?? "",
    shell.hasPendingUserInput,
    shell.hasPendingApprovals,
  ].join("|");
}

export interface ExpertsFeedEntry<T> {
  readonly key: string;
  readonly expert: T;
  readonly message: OrchestrationV2ThreadTailMessage;
  /** The newest entry of its expert, which carries the expert's status. */
  readonly latest: boolean;
}

/** Every expert's tail as one list, oldest first, like a chat. */
export function mergeExpertTails<T extends Pick<EnvironmentThreadShell, "environmentId" | "id">>(
  tails: ReadonlyArray<{
    readonly expert: T;
    readonly messages: ReadonlyArray<OrchestrationV2ThreadTailMessage>;
  }>,
): ExpertsFeedEntry<T>[] {
  const entries = tails.flatMap(({ expert, messages }) =>
    messages.map((message, index) => ({
      key: `${expertKey(expert)}:${message.itemId}`,
      expert,
      message,
      latest: index === messages.length - 1,
    })),
  );
  // The sort is stable, so one expert's messages keep their own order on equal times.
  return entries.toSorted(
    (left, right) => Date.parse(left.message.createdAt) - Date.parse(right.message.createdAt),
  );
}
