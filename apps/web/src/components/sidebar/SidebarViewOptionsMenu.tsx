import { msg, T, useMessages } from "gt-react";
import { ArrowUpDownIcon } from "lucide-react";
import type { ReactElement } from "react";

import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import {
  selectSidebarViewOptions,
  sidebarGroupingPatch,
  sidebarSortPatch,
  type SidebarGrouping,
  type SidebarThreadSort,
} from "../Sidebar.viewOptions";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

const SORT_OPTIONS: ReadonlyArray<{ readonly value: SidebarThreadSort; readonly label: string }> = [
  { value: "manual", label: msg("Manual", { $context: "sort order, as arranged by hand" }) },
  { value: "last_message", label: msg("Last message") },
  { value: "status", label: msg("Status", { $context: "sort order, by thread status" }) },
];

const GROUP_OPTIONS: ReadonlyArray<{ readonly value: SidebarGrouping; readonly label: string }> = [
  { value: "none", label: msg("None", { $context: "grouping, no grouping" }) },
  { value: "project", label: msg("Project") },
  { value: "machine", label: msg("Machine") },
  { value: "status", label: msg("Status", { $context: "grouping, by thread status" }) },
];

/** Client settings back these choices, so each device keeps its own. */
export function SidebarViewOptionsMenu(props: {
  // The sidebar header passes its own icon button: importing it here would close an import cycle.
  readonly trigger: ReactElement;
}) {
  const m = useMessages();
  const { sort, grouping } = useClientSettings(selectSidebarViewOptions);
  const backgroundSection = useClientSettings((s) => s.sidebarBackgroundSection);
  // The Working section orders the flat list by return time; folders replace it.
  const workingShelfOrders =
    useClientSettings((s) => s.sidebarWorkingShelfEnabled) && grouping === "none";
  return (
    <Menu>
      <MenuTrigger render={props.trigger}>
        <ArrowUpDownIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>
            <T>Sort</T>
            {workingShelfOrders ? (
              <span className="block font-normal">
                <T>Working section orders by return time</T>
              </span>
            ) : null}
          </MenuGroupLabel>
          <MenuRadioGroup
            value={sort}
            onValueChange={(value) => {
              const option = SORT_OPTIONS.find((candidate) => candidate.value === value);
              if (option) void updateClientSettings(sidebarSortPatch(option.value));
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <MenuRadioItem
                key={option.value}
                value={option.value}
                disabled={workingShelfOrders}
                closeOnClick
              >
                {m(option.label)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>
            <T>Group</T>
          </MenuGroupLabel>
          <MenuRadioGroup
            value={grouping}
            onValueChange={(value) => {
              const option = GROUP_OPTIONS.find((candidate) => candidate.value === value);
              if (option) void updateClientSettings(sidebarGroupingPatch(option.value));
            }}
          >
            {GROUP_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                {m(option.label)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem
          variant="switch"
          checked={backgroundSection}
          onCheckedChange={(checked) =>
            void updateClientSettings({ sidebarBackgroundSection: checked })
          }
        >
          <T>Background section</T>
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}
