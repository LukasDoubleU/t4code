import { useLocation, useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Opens the Experts feed from the Experts section header. */
export function ExpertsFeedButton() {
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
            aria-label="Experts feed"
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
      <TooltipPopup side="top">Experts feed: every expert's replies in one list</TooltipPopup>
    </Tooltip>
  );
}
