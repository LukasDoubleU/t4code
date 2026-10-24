import { ChevronDownIcon, CornerLeftUpIcon, PaperclipIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";

export function WorkspaceFileDropOverlay() {
  return (
    <div
      className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
      data-chat-workspace-drop-overlay="true"
    >
      <div
        role="status"
        className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
      >
        <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
        Drop files to attach
      </div>
    </div>
  );
}

/** Floating buttons over the timeline, `bottom` pixels up, clear of the composer and its banners. */
export function TimelineFloatingButtons(props: {
  readonly bottom: number;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center gap-1.5 py-1.5"
      style={{ bottom: props.bottom }}
    >
      {props.children}
    </div>
  );
}

function TimelineFloatingButton(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <Button
      aria-label={props.label}
      // Keeps focus, and so the caret, in the composer.
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className="pointer-events-auto"
      size="xs"
      variant="glass"
    >
      {props.icon}
      {props.label}
    </Button>
  );
}

export function ScrollToEndButton(props: { readonly onScrollToEnd: () => void }) {
  return (
    <TimelineFloatingButton
      label="Scroll to end"
      icon={<ChevronDownIcon className="size-3.5" />}
      onClick={props.onScrollToEnd}
    />
  );
}

export function MyLastMessageButton(props: { readonly onJump: () => void }) {
  return (
    <TimelineFloatingButton
      label="My last message"
      icon={<CornerLeftUpIcon className="size-3.5" />}
      onClick={props.onJump}
    />
  );
}
