import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

export type ThreadActionMenuId =
  | "dismiss-attention"
  | "find"
  | "new-thread-on-branch"
  | "start-topic"
  | "change-icon"
  | "use-project-icon"
  | "more"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "open-memory"
  | "fresh-start"
  | "open-continued-in"
  | "open-continued-from"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "account-failover"
  | "account-failover:enabled"
  | "account-failover:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "move-to-background"
  | "bring-to-front"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(
  options: {
    readonly hasPath: boolean;
    readonly hasBranch: boolean;
    readonly hasProject: boolean;
  },
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: resolve(msg("Copy", { $context: "submenu of things to copy" })),
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath
          ? [
              {
                id: "copy-path" as const,
                label: resolve(msg("Path", { $context: "copy the file path" })),
                icon: "folder",
              },
            ]
          : []),
        ...(options.hasBranch
          ? [
              {
                id: "copy-branch" as const,
                label: resolve(msg("Branch", { $context: "copy the git branch name" })),
                icon: "git-branch",
              },
            ]
          : []),
      ],
    },
    ...(options.hasProject
      ? [
          {
            id: "project-settings" as const,
            label: resolve(msg("Project settings")),
            icon: "settings",
          },
        ]
      : []),
    {
      id: "discard",
      label: resolve(msg("Discard draft")),
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly canFind?: boolean;
  /** False where no inline title editor is rendered, such as sidebar search results. */
  readonly canRename?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  /** An expert row on a server that files topics: the user can start one under it. */
  readonly canStartTopic?: boolean;
  /** The thread shows an icon of its own instead of its project's. */
  readonly hasOwnIcon?: boolean;
  /** The thread's agent asked for the user. */
  readonly needsYou?: boolean;
  /** A pinned thread whose memory is active. */
  readonly hasMemory?: boolean;
  /** A fresh start continued this thread in another one. */
  readonly continuedIn?: boolean;
  /** This thread continues another one after a fresh start. */
  readonly continuedFrom?: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  /** Whether a turn moves to the next account when the thread's account is used up. */
  readonly accountFailoverEnabled?: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  /** Where the sidebar's Background section lets this thread move; null hides both items. */
  readonly background?: {
    readonly placement: "background" | "front";
    readonly available: boolean;
  } | null;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly accountFailover?: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
    readonly freshStart?: boolean;
    readonly icons?: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
}

/**
 * Local navigation, read markers, sidebar placement, and copying remain available to
 * read-only clients.
 */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "find",
    "new-thread-on-branch",
    "more",
    "project-settings",
    "mark-unread",
    "open-memory",
    "open-continued-in",
    "open-continued-from",
    "move-to-background",
    "bring-to-front",
    "share-guest",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

/**
 * Everyday actions stay on top; the rest waits under More. Entries that only show in a given
 * state keep their places among the top ones.
 */
export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const more: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.hasMemory === true
      ? [{ id: "open-memory" as const, label: resolve(msg("Open memory")), icon: "brain" }]
      : []),
    ...(state.isPinned && state.supports.freshStart === true
      ? [{ id: "fresh-start" as const, label: resolve(msg("Fresh start")), icon: "rotate-ccw" }]
      : []),
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle
              ? resolve(msg("Regenerating…"))
              : resolve(msg("Regenerate title")),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: resolve(msg("Share with guest")), icon: "user-plus" }]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? resolve(msg("Show all projects"))
              : resolve(msg("Filter by {project}", { project: state.projectFilter.label })),
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: resolve(msg("Turn into project")),
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: resolve(msg("Auto-settle behavior")),
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: resolve(msg("Follow settings")),
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: resolve(msg("Never", { $context: "auto-settle never" })),
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    ...(state.supports.accountFailover === true
      ? [
          {
            id: "account-failover" as const,
            label: resolve(msg("At the usage limit")),
            icon: "arrow-right",
            children: [
              {
                id: "account-failover:enabled" as const,
                label: resolve(msg("Move to the next account")),
                checked: state.accountFailoverEnabled !== false,
              },
              {
                id: "account-failover:disabled" as const,
                label: resolve(msg("Stay on this account")),
                checked: state.accountFailoverEnabled === false,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: resolve(msg("Copy", { $context: "submenu of things to copy" })),
      icon: "copy",
      children: [
        {
          id: "copy-path",
          label: resolve(msg("Path", { $context: "copy the file path" })),
          icon: "folder",
        },
        ...(state.branch
          ? [
              {
                id: "copy-branch" as const,
                label: resolve(msg("Branch", { $context: "copy the git branch name" })),
                icon: "git-branch",
              },
            ]
          : []),
        {
          id: "copy-thread",
          label: resolve(msg("Thread", { $context: "copy the thread contents" })),
          icon: "message-square",
        },
      ],
    },
    { id: "project-settings", label: resolve(msg("Project settings")), icon: "settings" },
    {
      id: "archive",
      label: resolve(msg("Archive thread")),
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: resolve(msg("Delete", { $context: "verb, delete the thread" })),
      destructive: true,
      icon: "trash",
    },
  ];
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.needsYou === true
      ? [
          {
            id: "dismiss-attention" as const,
            label: resolve(msg("Dismiss Needs you")),
            icon: "check",
          },
        ]
      : []),
    ...(state.canFind
      ? [{ id: "find" as const, label: resolve(msg("Find in thread")), icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: resolve(msg("New thread on {branch}", { branch: state.branch })),
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.canStartTopic === true
      ? [
          {
            id: "start-topic" as const,
            label: resolve(msg("Start new topic")),
            icon: "messages-square",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: resolve(msg("Unpin thread")), icon: "pin-off" }
            : { id: "pin" as const, label: resolve(msg("Pin thread")), icon: "pin" },
        ]
      : []),
    ...(state.continuedIn === true
      ? [
          {
            id: "open-continued-in" as const,
            label: resolve(msg("Continued in new thread")),
            icon: "arrow-right",
          },
        ]
      : []),
    ...(state.continuedFrom === true
      ? [
          {
            id: "open-continued-from" as const,
            label: resolve(msg("Continued from earlier thread")),
            icon: "arrow-left",
          },
        ]
      : []),
    {
      id: "rename",
      label: resolve(msg("Rename thread")),
      icon: "pencil",
      disabled: state.canRename === false,
    },
    ...(state.supports.icons === true
      ? [
          { id: "change-icon" as const, label: resolve(msg("Change icon…")), icon: "smile" },
          ...(state.hasOwnIcon === true
            ? [
                {
                  id: "use-project-icon" as const,
                  label: resolve(msg("Use project icon")),
                  icon: "folder",
                },
              ]
            : []),
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? {
                id: "unsettle" as const,
                label: resolve(msg("Un-settle thread")),
                icon: "circle-check",
              }
            : { id: "settle" as const, label: resolve(msg("Settle thread")), icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: resolve(msg("Wake thread")), icon: "clock" }
            : {
                id: "snooze" as const,
                label: resolve(msg("Snooze", { $context: "verb, snooze the thread" })),
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: preset.label,
                    detail: preset.whenLabel,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: resolve(msg("Custom…")),
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    ...(state.background?.placement === "background"
      ? [
          {
            id: "move-to-background" as const,
            label: resolve(msg("Move to background")),
            icon: "send-to-back",
            disabled: !state.background.available,
          },
        ]
      : state.background?.placement === "front"
        ? [
            {
              id: "bring-to-front" as const,
              label: resolve(msg("Bring to front")),
              icon: "bring-to-front",
            },
          ]
        : []),
    { id: "mark-unread", label: resolve(msg("Mark unread")), icon: "mail-open" },
    { id: "copy-thread-id", label: resolve(msg("Copy thread ID")), icon: "hash" },
    {
      id: "more",
      label: resolve(msg("More")),
      icon: "ellipsis",
      separatorBefore: true,
      children: more,
    },
  ];
  return state.canOperate ? items : items.map(disableOperations);
}

function disableOperations(
  item: ContextMenuItem<ThreadActionMenuId>,
): ContextMenuItem<ThreadActionMenuId> {
  if (!threadActionRequiresOperate(item.id)) {
    return item.children ? { ...item, children: item.children.map(disableOperations) } : item;
  }
  return {
    ...item,
    disabled: true,
    ...(item.children
      ? {
          children: item.children.map((child) => ({ ...disableOperations(child), disabled: true })),
        }
      : {}),
  };
}
