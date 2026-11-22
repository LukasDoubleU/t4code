import { useLocation, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { MessagesSquareIcon } from "lucide-react";

import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Opens the Experts feed from the Experts section header. */
export function ExpertsFeedButton() {
  const gt = useGT();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const open = useLocation({ select: (location) => location.pathname === "/experts" });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Experts feed")}
            aria-pressed={open}
            data-testid="sidebar-experts-feed"
            onClick={() => {
              if (isMobile) setOpenMobile(false);
              void navigate({ to: "/experts" });
            }}
          />
        }
      >
        <MessagesSquareIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <T>Experts feed: every expert's replies in one list</T>
      </TooltipPopup>
    </Tooltip>
  );
}
