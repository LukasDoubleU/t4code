import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  HandIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import type { SidebarFolderHeader, SidebarStatusGroup } from "../Sidebar.viewOptions";

const STATUS_FOLDERS: Record<
  SidebarStatusGroup,
  { readonly label: string; readonly Icon: LucideIcon; readonly className: string }
> = {
  needs_you: { label: "Needs you", Icon: HandIcon, className: "text-warning-foreground" },
  failed: { label: "Failed", Icon: CircleAlertIcon, className: "text-error" },
  working: { label: "Working", Icon: CircleDashedIcon, className: "text-info" },
  completed: { label: "Completed", Icon: CircleCheckIcon, className: "text-success" },
  idle: { label: "Idle", Icon: CircleIcon, className: "text-muted-foreground" },
};

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const NO_VISITS: Readonly<Record<string, string>> = {};

type SidebarGroupFolder = Exclude<SidebarFolderHeader<unknown>, { readonly kind: "project" }>;

function folderTitle(
  header: SidebarGroupFolder,
  machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>,
): { readonly label: string; readonly icon: ReactNode } {
  if (header.kind === "machine") {
    return {
      label: header.label,
      icon: (
        <EnvironmentMachineIcon
          aria-hidden
          kind={machineByEnvironmentId.get(header.environmentId) ?? "server"}
          className="size-4 shrink-0 text-muted-foreground"
        />
      ),
    };
  }
  const { label, Icon, className } = STATUS_FOLDERS[header.status];
  return { label, icon: <Icon aria-hidden className={cn("size-4 shrink-0", className)} /> };
}

/** A machine or status folder. Unlike a project folder it is no place to start a thread. */
export const SidebarGroupFolderHeader = memo(function SidebarGroupFolderHeader(props: {
  folderKey: string;
  header: SidebarGroupFolder;
  collapsed: boolean;
  hiddenInbox: readonly EnvironmentThreadShell[];
  machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  onToggle: (folderKey: string) => void;
}) {
  const { header, collapsed, hiddenInbox } = props;
  // A status folder already names its threads' state, so only a closed machine folder
  // flags what it hides.
  const showsDot = collapsed && header.kind === "machine";
  const localLastVisitedAtById = useUiStateStore((state) =>
    showsDot ? state.threadLastVisitedAtById : NO_VISITS,
  );
  const folderDot = showsDot
    ? resolveSidebarFolderDot(
        hiddenInbox.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  const { label, icon } = folderTitle(header, props.machineByEnvironmentId);
  return (
    <li className="relative mt-1 list-none first:mt-0">
      <button
        type="button"
        aria-expanded={!collapsed}
        data-testid="sidebar-group-folder"
        onClick={() => props.onToggle(props.folderKey)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150",
            !collapsed && "rotate-90",
          )}
        />
        {icon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {label}
        </span>
        {folderDot ? (
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[folderDot])}
          />
        ) : null}
        {collapsed && hiddenInbox.length > 0 ? (
          <span className="shrink-0 text-xs text-secondary-label tabular-nums">
            {hiddenInbox.length}
          </span>
        ) : null}
      </button>
    </li>
  );
});
