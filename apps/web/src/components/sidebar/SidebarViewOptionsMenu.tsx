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
  { value: "manual", label: "Manual" },
  { value: "last_message", label: "Last message" },
  { value: "status", label: "Status" },
];

const GROUP_OPTIONS: ReadonlyArray<{ readonly value: SidebarGrouping; readonly label: string }> = [
  { value: "none", label: "None" },
  { value: "project", label: "Project" },
  { value: "machine", label: "Machine" },
  { value: "status", label: "Status" },
];

/** Client settings back these choices, so each device keeps its own. */
export function SidebarViewOptionsMenu(props: {
  // The sidebar header passes its own icon button: importing it here would close an import cycle.
  readonly trigger: ReactElement;
}) {
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
            Sort
            {workingShelfOrders ? (
              <span className="block font-normal">Working section orders by return time</span>
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
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Group</MenuGroupLabel>
          <MenuRadioGroup
            value={grouping}
            onValueChange={(value) => {
              const option = GROUP_OPTIONS.find((candidate) => candidate.value === value);
              if (option) void updateClientSettings(sidebarGroupingPatch(option.value));
            }}
          >
            {GROUP_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                {option.label}
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
          Background section
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}
