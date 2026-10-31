import {
  EMPTY_SINCE_LAST_VISIT_MARKER,
  nextSinceLastVisitMarker,
} from "@t3tools/client-runtime/state/thread-catch-up";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ComponentProps, useLayoutEffect, useState } from "react";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import type { TimelineEntriesInput, TimelineEntry } from "../../session-logic";
import { useTimelineVisibleTurnItems } from "../../state/entities";
import {
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
} from "../ChatView.logic";
import { MessagesTimeline } from "./MessagesTimeline";

/**
 * The timeline with the streamed text. ChatView reads the thread through its quiet
 * atoms, which hold through text deltas; this reads the live turn items, so a
 * reasoning delta re-renders the timeline without re-rendering ChatView. Streamed
 * assistant text reaches only its own row, through useAssistantMessageText.
 */
export function ThreadTimeline({
  threadDetailRef,
  entriesInput,
  draftEntries,
  activeThreadKey,
  syncing,
  detailLoading,
  lastVisitedAt,
  ...timelineProps
}: Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries" | "sinceLastVisitAt"> & {
  /** Null until the thread's detail may load; see resolveThreadDetailRef. */
  threadDetailRef: ScopedThreadRef | null;
  entriesInput: Omit<TimelineEntriesInput, "visibleTurnItems">;
  /** A local draft's optimistic rows; null for a server thread. */
  draftEntries: ReadonlyArray<TimelineEntry> | null;
  activeThreadKey: string | null;
  syncing: boolean;
  detailLoading: boolean;
  /** The thread's last visit; undefined while its shell is unknown. */
  lastVisitedAt: string | null | undefined;
}) {
  const visibleTurnItems = useTimelineVisibleTurnItems(threadDetailRef);
  const serverEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...entriesInput,
    visibleTurnItems,
  });
  const entries = draftEntries ?? serverEntries;
  const displayedEntries = resolveThreadSwitchTimeline({
    loading: entries.length === 0 && syncing,
    activeThreadKey,
    nextEntries: entries,
    rememberedForActive: peekRememberedThreadTimeline<typeof entries>(activeThreadKey),
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stores the committed ready timeline in the module-level cache used during thread switches
  useLayoutEffect(() => {
    if (detailLoading || entries.length === 0 || timelineHasEphemeralPreviewUrls(entries)) {
      return;
    }
    rememberReadyThreadTimeline({ threadKey: activeThreadKey, entries });
  }, [activeThreadKey, detailLoading, entries]);
  const sinceLastVisitAt = useSinceLastVisitAt({
    threadKey: draftEntries === null ? activeThreadKey : null,
    lastVisitedAt,
    entries,
    ready: !detailLoading && entries.length > 0,
  });
  return (
    <MessagesTimeline
      {...timelineProps}
      timelineEntries={displayedEntries}
      sinceLastVisitAt={sinceLastVisitAt}
    />
  );
}

function useSinceLastVisitAt(input: {
  readonly threadKey: string | null;
  readonly lastVisitedAt: string | null | undefined;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly ready: boolean;
}): string | null {
  const [marker, setMarker] = useState(EMPTY_SINCE_LAST_VISIT_MARKER);
  const next = nextSinceLastVisitMarker(marker, {
    threadKey: input.threadKey,
    lastVisitedAt: input.lastVisitedAt,
    items: input.entries,
    itemsReady: input.ready,
  });
  if (next !== marker) setMarker(next);
  return next.threadKey === null ? null : (next.at ?? null);
}
