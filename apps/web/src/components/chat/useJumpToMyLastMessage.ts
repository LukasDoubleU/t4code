import type { LegendListRef } from "@legendapp/list/react";
import {
  isUserAuthoredMessage,
  nextJumpToMyLastMessageStep,
  subscribeThreadCatchUpAction,
} from "@t3tools/client-runtime/state/thread-catch-up";
import { useEffect, useEffectEvent, useRef, type RefObject } from "react";

import { toastManager } from "../ui/toast";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";

/** Scrolls to the user's latest message on request, loading older turns until it is there. */
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
  const requestedPagesRef = useRef<Set<string> | null>(null);

  const tryJump = useEffectEvent(() => {
    const requestedPages = requestedPagesRef.current;
    if (requestedPages === null) return;
    const step = nextJumpToMyLastMessageStep({
      index: rows.findLastIndex(
        (row) => row.kind === "message" && isUserAuthoredMessage(row.message),
      ),
      oldestItemId: input.entries[0]?.id,
      history: historyControls,
      requestedPages,
    });
    if (step.type === "wait") return;
    if (step.type === "load") {
      requestedPages.add(step.cursor);
      historyControls?.onLoadEarlier();
      return;
    }
    requestedPagesRef.current = null;
    if (step.type === "scroll") {
      input.onManualNavigation();
      void input.listRef.current?.scrollToIndex({
        index: step.index,
        animated: !input.reducedMotion,
        viewOffset: 24,
      });
    } else {
      toastManager.add(
        step.type === "failed"
          ? { type: "warning", title: "Could not load earlier turns", description: step.error }
          : {
              type: "info",
              title: "No message from you here",
              description: "You have not written in this thread yet, or it is too far back.",
            },
      );
    }
  });

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeThreadCatchUpAction("jump-to-my-last-message", threadKey, () => {
      requestedPagesRef.current = new Set();
      tryJump();
    });
    return () => {
      unsubscribe();
      requestedPagesRef.current = null;
    };
  }, [enabled, threadKey]);

  // Each loaded page re-renders the rows; keep going until the message is in them.
  useEffect(() => {
    if (requestedPagesRef.current !== null) tryJump();
  }, [rows, historyControls?.loading, historyControls?.hasMoreHistory, historyControls?.error]);
}
