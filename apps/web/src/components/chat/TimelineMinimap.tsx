import {
  resolveTimelineMinimapPreview,
  type TimelineMinimapItem,
  type TimelineMinimapMark,
} from "./timelineMinimapItems";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapMarkCapacity,
  resolveTimelineMinimapNavigationInteractive,
  resolveTimelineMinimapTopPercent,
  TIMELINE_MINIMAP_MIN_ITEMS,
} from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

// A release outside the window can skip `mouseup`, so the next button-free
// `mousemove` also counts.
function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) return;
    stop();
    onRelease();
  };
  const stop = () => {
    window.removeEventListener("mouseup", check);
    window.removeEventListener("mousemove", check);
  };
  window.addEventListener("mouseup", check);
  window.addEventListener("mousemove", check);
  return stop;
}

export function TimelineMinimap({
  hasPersistentGutter,
  hitStripWidth,
  currentIndex,
  items,
  marks,
  stripMap,
  onWheel,
  onMarkCapacityChange,
  onSelect,
}: {
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  /** Index into `items`, so previous and next still step one turn inside a group. */
  currentIndex: number | null;
  items: ReadonlyArray<TimelineMinimapItem>;
  marks: ReadonlyArray<TimelineMinimapMark>;
  stripMap: Map<string, HTMLSpanElement>;
  onWheel: (event: WheelEvent) => void;
  onMarkCapacityChange: (capacity: number | null) => void;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const wheelTargetRef = (node: HTMLDivElement | null) => {
    if (!node) return;
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  };
  const railRef = (node: HTMLDivElement | null) => {
    if (!node) return;
    return observeResize(node, (entries) => {
      const height = entries.at(-1)?.contentRect.height;
      if (height !== undefined) onMarkCapacityChange(resolveTimelineMinimapMarkCapacity(height));
    });
  };

  const pressedOnStripRef = useRef(false);
  const [passThrough, setPassThrough] = useState(false);

  useEffect(() => {
    if (!passThrough) return;
    return onMouseButtonsReleased(() => setPassThrough(false));
  }, [passThrough]);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < marks.length ? activeIndex : null;
  const activeMark = resolvedActiveIndex === null ? null : (marks[resolvedActiveIndex] ?? null);
  const activePreview = resolveTimelineMinimapPreview(activeMark);
  const navigationInteractive =
    resolveTimelineMinimapNavigationInteractive(hitStripWidth) && !passThrough;
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, marks.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === marks.length - 1
          ? "-100%"
          : "-50%";
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null;
  const previousItem =
    resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem = resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex + 1] ?? null);
  const currentMarkIndex =
    resolvedCurrentIndex === null
      ? null
      : marks.findLastIndex((mark) => mark.firstItemIndex <= resolvedCurrentIndex);

  const resolveActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return resolveTimelineMinimapIndexFromPointer({
      itemCount: marks.length,
      railTop: rect.top,
      railHeight: rect.height,
      pointerY: event.clientY,
    });
  };

  const updateActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const nextIndex = resolveActiveIndexFromPointer(event);
    setActiveIndex(nextIndex);
  };

  const moveActiveIndex = (delta: number) => {
    setActiveIndex((current) => {
      const base = current ?? 0;
      return Math.max(0, Math.min(marks.length - 1, base + delta));
    });
  };

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      ref={wheelTargetRef}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2",
            hitStripWidth > 0 && !passThrough ? "pointer-events-auto" : "pointer-events-none",
          )}
          onMouseDown={() => {
            if (pressedOnStripRef.current) return;
            pressedOnStripRef.current = true;
            onMouseButtonsReleased(() => {
              pressedOnStripRef.current = false;
            });
          }}
          onMouseMove={(event) => {
            if (event.buttons !== 0 && !pressedOnStripRef.current) setPassThrough(true);
          }}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(hitStripWidth, activePreview !== null),
          }}
          ref={railRef}
        >
          <TimelineMinimapNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) onSelect(previousItem);
            }}
          />
          <button
            aria-label={
              activePreview?.kind === "group"
                ? `Jump to ${activePreview.turnCount} turns from: ${activePreview.firstUserText ?? "User message"}`
                : `Jump to message: ${activePreview?.userText ?? "User message"}`
            }
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onBlur={() => setActiveIndex(null)}
            onClick={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              const nextIndex = resolveActiveIndexFromPointer(event);
              const selectedItem = nextIndex === null ? null : (marks[nextIndex]?.items[0] ?? null);
              if (selectedItem) {
                onSelect(selectedItem);
              }
              event.currentTarget.blur();
            }}
            onFocus={() => setActiveIndex((current) => current ?? currentMarkIndex ?? 0)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveIndex(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveIndex(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(marks.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                const selectedItem = activeMark?.items[0];
                if (selectedItem) {
                  onSelect(selectedItem);
                }
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={(event) => {
              if (event.buttons !== 0 && !pressedOnStripRef.current) return;
              updateActiveIndexFromPointer(event);
            }}
            onMouseDown={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              event.preventDefault();
            }}
            type="button"
          >
            <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
            {marks.map((mark, index) => {
              const top = `${resolveTimelineMinimapTopPercent(index, marks.length)}%`;
              const activeDistance =
                resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
              return (
                // Compositor-friendly on purpose: in-view state and the hover
                // fisheye animate constantly (every scroll tick and streaming
                // update flips a band of strips), so the strip animates only
                // transform and opacity.
                <span
                  aria-hidden="true"
                  className={cn(
                    "group/strip pointer-events-none absolute left-0 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-150",
                    mark.items.length > 1 ? "h-1" : "h-0.5",
                    activeDistance === 0 ? "bg-muted-foreground/75" : "bg-muted-foreground/35",
                    activeDistance === 0
                      ? "scale-x-100"
                      : activeDistance === 1
                        ? "scale-x-[0.667]"
                        : activeDistance === 2
                          ? "scale-x-[0.417]"
                          : "scale-x-[0.333]",
                  )}
                  data-in-view="false"
                  data-minimap-strip
                  key={mark.id}
                  ref={(node) => {
                    if (node) {
                      stripMap.set(mark.id, node);
                    } else {
                      stripMap.delete(mark.id);
                    }
                  }}
                  style={{ top }}
                >
                  <span className="absolute inset-0 rounded-full bg-foreground/90 opacity-0 transition-opacity duration-150 group-data-[in-view=true]/strip:opacity-100" />
                </span>
              );
            })}
            {activePreview ? (
              <span
                className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
                data-minimap-preview
                onMouseMove={(event) => event.stopPropagation()}
                style={{
                  top: `${activeTopPercent}%`,
                  transform: `translateY(${activeTooltipTranslate})`,
                }}
              >
                <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                  {activePreview.kind === "group" ? (
                    <>
                      <span className="block text-muted-foreground text-xs leading-4">
                        {activePreview.turnCount} turns
                      </span>
                      <span className="mt-1 block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                        {activePreview.firstUserText ?? "User message"}
                      </span>
                      <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground text-sm leading-5">
                        to {activePreview.lastUserText ?? "User message"}
                      </span>
                    </>
                  ) : (
                    <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                      {activePreview.userText ?? "User message"}
                    </span>
                  )}
                  {activePreview.kind === "turn" && activePreview.assistantText ? (
                    <span
                      className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                      style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                      }}
                    >
                      {activePreview.assistantText}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </button>
          <TimelineMinimapNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function TimelineMinimapNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
              interactive ? "pointer-events-auto" : "pointer-events-none",
              previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
            )}
          />
        }
      >
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-micro"
          type="button"
          variant="ghost-muted"
        >
          <Icon className="size-4 text-foreground/90" />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side={previous ? "top" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}
