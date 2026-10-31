import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  ClientSettings,
  ClientSettingsPatch,
  SidebarThreadGrouping,
} from "@t3tools/contracts/settings";

import type { SidebarThreadSummary } from "../types";
import {
  groupSidebarThreadsByProject,
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  sidebarFolderExpansionKeys,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";

export type SidebarThreadSort = "manual" | "last_message" | "status";
export type SidebarGrouping = "none" | "project" | Exclude<SidebarThreadGrouping, "none">;

interface SidebarViewOptions {
  readonly sort: SidebarThreadSort;
  readonly grouping: SidebarGrouping;
}

type SidebarViewOptionSettings = Pick<
  ClientSettings,
  | "boringSidebarEnabled"
  | "legacySidebarEnabled"
  | "sidebarSortByLastMessage"
  | "sidebarSortByStatus"
  | "sidebarThreadGrouping"
>;

/**
 * Project folders and the last-message sort keep the settings they already had, and the
 * Beta switch writes project folders too. They win over the other groupings so that
 * switch always matches the sidebar.
 */
export function selectSidebarViewOptions(settings: SidebarViewOptionSettings): SidebarViewOptions {
  return {
    sort: settings.sidebarSortByStatus
      ? "status"
      : settings.sidebarSortByLastMessage
        ? "last_message"
        : "manual",
    grouping:
      settings.boringSidebarEnabled || settings.legacySidebarEnabled
        ? "project"
        : settings.sidebarThreadGrouping,
  };
}

export function sidebarSortPatch(sort: SidebarThreadSort): ClientSettingsPatch {
  return {
    sidebarSortByLastMessage: sort === "last_message",
    sidebarSortByStatus: sort === "status",
  };
}

export function sidebarGroupingPatch(grouping: SidebarGrouping): ClientSettingsPatch {
  // Like the Beta switch, clear the legacy opt-in that also turns project folders on.
  return {
    boringSidebarEnabled: grouping === "project",
    legacySidebarEnabled: false,
    sidebarThreadGrouping: grouping === "project" ? "none" : grouping,
  };
}

/**
 * In sidebar order: what needs the user first, so an unseen result comes before work still
 * running, and idle threads last.
 */
const SIDEBAR_STATUS_GROUPS = ["needs_you", "failed", "completed", "working", "idle"] as const;
export type SidebarStatusGroup = (typeof SIDEBAR_STATUS_GROUPS)[number];

type SidebarStatusGroupInput = Parameters<typeof resolveSidebarThreadStatus>[0] &
  Parameters<typeof hasUnseenCompletion>[0] &
  Parameters<typeof threadWokeAt>[0] &
  Pick<SidebarThreadSummary, "lastVisitedAt" | "settledOverride">;

/**
 * The status a thread's row shows, as a group: Approval, Input, Needs you and Woke need the user;
 * Limited counts as failed; Waiting as working; Done as completed; a row without a
 * status label is idle.
 */
export function resolveSidebarStatusGroup(
  thread: SidebarStatusGroupInput,
  context: { readonly now: string; readonly localLastVisitedAt: string | undefined },
): SidebarStatusGroup {
  const status = resolveSidebarThreadStatus(thread);
  if (
    status === "approval" ||
    status === "input" ||
    status === "request" ||
    thread.attention != null
  ) {
    return "needs_you";
  }
  if (status === "failed" || status === "limited") return "failed";
  if (status === "working" || status === "waiting") return "working";
  const lastVisitedAt = resolveThreadLastVisitedAt(
    thread.lastVisitedAt,
    context.localLastVisitedAt,
  );
  // Same rule as the row's Woke label: a snooze that ended since the last visit.
  const wokeAtMs = Date.parse(threadWokeAt(thread, { now: context.now }) ?? "");
  const lastVisitedMs = Date.parse(lastVisitedAt ?? "");
  if (
    !Number.isNaN(wokeAtMs) &&
    (Number.isNaN(lastVisitedMs) || lastVisitedMs < wokeAtMs) &&
    thread.settledOverride !== "settled"
  ) {
    return "needs_you";
  }
  return hasUnseenCompletion({ ...thread, lastVisitedAt }) ? "completed" : "idle";
}

function bucketByStatus<T>(
  threads: readonly T[],
  statusGroupOf: (thread: T) => SidebarStatusGroup,
): Map<SidebarStatusGroup, T[]> {
  const buckets = new Map<SidebarStatusGroup, T[]>(
    SIDEBAR_STATUS_GROUPS.map((status) => [status, []]),
  );
  for (const thread of threads) buckets.get(statusGroupOf(thread))!.push(thread);
  return buckets;
}

type ActiveSortInput = Parameters<typeof sortThreadsForSidebar>[0][number];

export function sortSidebarActiveThreads<T extends ActiveSortInput>(
  threads: readonly T[],
  sort: SidebarThreadSort,
  statusGroupOf: (thread: T) => SidebarStatusGroup,
): T[] {
  if (sort !== "status") return sortThreadsForSidebar(threads, sort === "last_message");
  // Newest message first within each status, like the Last message sort.
  const buckets = bucketByStatus(sortThreadsForSidebar(threads, true), statusGroupOf);
  return SIDEBAR_STATUS_GROUPS.flatMap((status) => buckets.get(status)!);
}

type PinnedSortInput = ActiveSortInput & Parameters<typeof sortPinnedThreadsForSidebar>[0][number];

/** Pinned threads follow the sort too; only Manual keeps their dragged order. */
export function sortSidebarPinnedThreads<T extends PinnedSortInput>(
  threads: readonly T[],
  sort: SidebarThreadSort,
  statusGroupOf: (thread: T) => SidebarStatusGroup,
): T[] {
  return sort === "manual"
    ? sortPinnedThreadsForSidebar(threads)
    : sortSidebarActiveThreads(threads, sort, statusGroupOf);
}

export type SidebarFolderHeader<TGroup> =
  | { readonly kind: "project"; readonly group: TGroup }
  | { readonly kind: "machine"; readonly environmentId: EnvironmentId; readonly label: string }
  | { readonly kind: "status"; readonly status: SidebarStatusGroup };

interface SidebarThreadFolder<TThread, TGroup> {
  /** Unique among the folders, so it also keys the folder's settled list. */
  readonly key: string;
  /** Where the folder's open state is saved, most specific first. */
  readonly expansionKeys: readonly string[];
  readonly header: SidebarFolderHeader<TGroup>;
  readonly threads: readonly TThread[];
}

type SidebarFolderProjectGroup = Parameters<typeof groupSidebarThreadsByProject>[0][number] &
  Parameters<typeof sidebarFolderExpansionKeys>[0];

const UNKNOWN_MACHINE_LABEL = "Unknown machine";

/**
 * Folders hold active threads in their given order, so the chosen sort applies inside
 * them. A project without threads gets a folder only when `keepEmpty` says so; machine and
 * status folders only appear while they hold threads.
 */
export function groupSidebarThreads<
  TThread extends Pick<SidebarThreadSummary, "environmentId" | "projectId">,
  TGroup extends SidebarFolderProjectGroup,
>(input: {
  readonly grouping: Exclude<SidebarGrouping, "none">;
  readonly projectGroups: readonly TGroup[];
  readonly machines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly threads: readonly TThread[];
  readonly keepEmpty: (group: TGroup) => boolean;
  readonly statusGroupOf: (thread: TThread) => SidebarStatusGroup;
}): SidebarThreadFolder<TThread, TGroup>[] {
  type Folder = SidebarThreadFolder<TThread, TGroup>;
  switch (input.grouping) {
    case "project":
      return groupSidebarThreadsByProject(input.projectGroups, input.threads, input.keepEmpty).map(
        (folder): Folder => ({
          key: folder.group.projectKey,
          expansionKeys: sidebarFolderExpansionKeys(folder.group),
          header: { kind: "project", group: folder.group },
          threads: folder.threads,
        }),
      );
    case "machine": {
      const labelById = new Map(
        input.machines.map((machine) => [machine.environmentId, machine.label] as const),
      );
      const folders = new Map<EnvironmentId, TThread[]>();
      for (const thread of input.threads) {
        const folder = folders.get(thread.environmentId);
        if (folder === undefined) folders.set(thread.environmentId, [thread]);
        else folder.push(thread);
      }
      return [...folders]
        .map(([environmentId, threads]) => ({
          environmentId,
          label: labelById.get(environmentId) ?? UNKNOWN_MACHINE_LABEL,
          threads,
        }))
        .toSorted(
          (left, right) =>
            Number(right.environmentId === input.primaryEnvironmentId) -
              Number(left.environmentId === input.primaryEnvironmentId) ||
            left.label.localeCompare(right.label) ||
            left.environmentId.localeCompare(right.environmentId),
        )
        .map(({ environmentId, label, threads }): Folder => {
          const key = `sidebar-machine:${environmentId}`;
          return {
            key,
            expansionKeys: [key],
            header: { kind: "machine", environmentId, label },
            threads,
          };
        });
    }
    case "status": {
      const buckets = bucketByStatus(input.threads, input.statusGroupOf);
      return SIDEBAR_STATUS_GROUPS.flatMap((status): Folder[] => {
        const threads = buckets.get(status)!;
        if (threads.length === 0) return [];
        const key = `sidebar-status:${status}`;
        return [{ key, expansionKeys: [key], header: { kind: "status", status }, threads }];
      });
    }
  }
}
