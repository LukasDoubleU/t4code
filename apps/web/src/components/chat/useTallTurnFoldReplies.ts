import type { LegendListRef } from "@legendapp/list/react";
import { type RefObject, useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { tallTurnFoldReplyKey, type TurnFoldReply } from "./MessageTime";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";

const NO_TALL_REPLIES: { readonly key: string; readonly ids: ReadonlySet<string> } = {
  key: "",
  ids: new Set(),
};

/**
 * The fold replies that also show their time at their end. Reads the row sizes LegendList has
 * already measured, at most once a frame, when the timeline reports a row or viewport resize.
 */
export function useTallTurnFoldReplies(input: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly replies: ReadonlyMap<string, TurnFoldReply>;
  readonly composerInset: number;
}) {
  const { listRef, replies, composerInset } = input;
  // The set lives in state next to its key so the row context only changes when the set does.
  const [tall, setTall] = useState(NO_TALL_REPLIES);
  const refresh = useStableCallback(() => {
    const state = listRef.current?.getState?.();
    if (!state) return;
    const key = tallTurnFoldReplyKey(
      replies,
      (messageId) => {
        const index = state.indexByKey(messageId);
        return index === undefined ? undefined : state.sizeAtIndex(index);
      },
      state.scrollLength - composerInset - CHAT_TIMELINE_ANCHOR_OFFSET,
    );
    setTall((current) =>
      current.key === key ? current : { key, ids: new Set(key === "" ? [] : key.split("\n")) },
    );
  });
  const frameRef = useRef<number | null>(null);
  const scheduleRefresh = useStableCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      refresh();
    });
  });
  useEffect(() => {
    scheduleRefresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Settled replies and the composer inset change which replies count as tall.
  }, [scheduleRefresh, replies, composerInset]);
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );
  return { tallReplyIds: tall.ids, scheduleRefresh };
}
