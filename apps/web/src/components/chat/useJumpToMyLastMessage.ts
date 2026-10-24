import type { LegendListRef } from "@legendapp/list/react";
import { isUserAuthoredMessage } from "@t3tools/client-runtime/state/thread-catch-up";
import { useEffect, useEffectEvent, useRef, type RefObject } from "react";

import { toastManager } from "../ui/toast";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import { subscribeJumpToMyLastMessage } from "./threadCatchUpActionBus";

// A thread whose last message from the user is further back than this many pages gives up
// instead of loading its whole history.
const MAX_HISTORY_PAGES = 20;

/** Scrolls to the user's latest message on request, loading older history until it is there. */
export function useJumpToMyLastMessage(input: {
  readonly threadKey: string;
  readonly enabled: boolean;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly entries: ReadonlyArray<{ readonly id: string }>;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly historyControls: MessagesTimelineHistoryControls | undefined;
  readonly reducedMotion: boolean;
  readonly onManualNavigation: () => void;
}) {
  const { threadKey, enabled, rows, historyControls } = input;
  const pendingRef = useRef<{ readonly requestedPages: Set<string> } | null>(null);

  const tryJump = useEffectEvent(() => {
    const pending = pendingRef.current;
    if (pending === null) return;
    const index = rows.findLastIndex(
      (row) => row.kind === "message" && isUserAuthoredMessage(row.message),
    );
    if (index >= 0) {
      pendingRef.current = null;
      input.onManualNavigation();
      void input.listRef.current?.scrollToIndex({
        index,
        animated: !input.reducedMotion,
        viewOffset: 24,
      });
      return;
    }
    if (historyControls?.hasMoreHistory && historyControls.error === null) {
      if (historyControls.loading) return;
      const cursor = input.entries[0]?.id ?? "first";
      if (!pending.requestedPages.has(cursor) && pending.requestedPages.size < MAX_HISTORY_PAGES) {
        pending.requestedPages.add(cursor);
        historyControls.onLoadEarlier();
        return;
      }
    }
    pendingRef.current = null;
    toastManager.add({
      type: "info",
      title: historyControls?.error ? "Could not load earlier turns" : "No message from you here",
      description:
        historyControls?.error ??
        "Your last message is not in this thread's history, or you have not written one yet.",
    });
  });

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeJumpToMyLastMessage(threadKey, () => {
      pendingRef.current = { requestedPages: new Set() };
      tryJump();
    });
    return () => {
      unsubscribe();
      pendingRef.current = null;
    };
  }, [enabled, threadKey]);

  // Each loaded page re-renders the rows; keep going until the message is in them.
  useEffect(() => {
    if (pendingRef.current !== null) tryJump();
  }, [rows, historyControls?.loading, historyControls?.hasMoreHistory, historyControls?.error]);
}
