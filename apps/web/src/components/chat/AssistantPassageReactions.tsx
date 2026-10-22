import type {
  AssistantCitation,
  AssistantPassage,
  EnvironmentId,
  MessageId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { PlayIcon, ThumbsDownIcon, ThumbsUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { findAssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { cn } from "~/lib/utils";
import type { ChatPassageReaction } from "../../types";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PASSAGE_GO_AHEAD_LABEL,
  citationPassage,
  passageReactionChips,
} from "./AssistantPassageReactions.logic";
import { reactableReply } from "./AssistantReactions.logic";
import { useReplyReactions } from "./AssistantReactions";

const PASSAGE_HIGHLIGHT = "t3-assistant-reaction-passage";

type ReplyReactions = ReturnType<typeof useReplyReactions>;

/** 👍, 👎 and Go ahead on the selected passage, next to Cite in the selection toolbar. */
export function AssistantSelectionReactions(props: {
  readonly reactions: Pick<ReplyReactions, "react" | "goAheadOnPassage">;
  readonly reply: { readonly threadId: ThreadId; readonly itemId: TurnItemId };
  readonly citation: AssistantCitation;
  readonly disabled: boolean;
  /** Called once a button sent its command, like Cite, to let go of the selection. */
  readonly onDone: () => void;
}) {
  const passage = citationPassage(props.citation);
  const actions: ReadonlyArray<{
    readonly label: string;
    readonly icon: ReactNode;
    readonly run: () => Promise<void>;
  }> = [
    {
      label: "React 👍 to this passage (no reply)",
      icon: <ThumbsUpIcon aria-hidden="true" />,
      run: () => props.reactions.react(props.reply, "👍", true, passage),
    },
    {
      label: "React 👎 to this passage (no reply)",
      icon: <ThumbsDownIcon aria-hidden="true" />,
      run: () => props.reactions.react(props.reply, "👎", true, passage),
    },
    {
      label: PASSAGE_GO_AHEAD_LABEL,
      icon: <PlayIcon aria-hidden="true" className="fill-current text-success" />,
      run: () => props.reactions.goAheadOnPassage(props.reply, props.citation),
    },
  ];

  return actions.map((action) => (
    <Tooltip key={action.label}>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="glass"
            disabled={props.disabled}
            aria-label={action.label}
            onClick={() => {
              void action.run();
              props.onDone();
            }}
          />
        }
      >
        {action.icon}
      </TooltipTrigger>
      <TooltipPopup side="top">{action.label}</TooltipPopup>
    </Tooltip>
  ));
}

/** Paints the passage in its reply, without changing the reply's DOM, until the result runs. */
function highlightPassage(citation: AssistantCitation): (() => void) | null {
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) {
    return null;
  }
  const range = findAssistantCitationSourceAnchor(document, citation)?.range;
  if (!range) return null;
  const highlight = new Highlight(range);
  CSS.highlights.set(PASSAGE_HIGHLIGHT, highlight);
  return () => {
    if (CSS.highlights.get(PASSAGE_HIGHLIGHT) === highlight)
      CSS.highlights.delete(PASSAGE_HIGHLIGHT);
  };
}

/** The reply's passage reactions as chips. Hover or focus shows the passage; × removes it. */
export function AssistantPassageReactionChips(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly messageId: MessageId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem | undefined;
  readonly reactions: ReadonlyArray<ChatPassageReaction> | undefined;
}) {
  if (props.reactions === undefined || props.reactions.length === 0) return null;
  return <PassageChips {...props} reactions={props.reactions} />;
}

function PassageChips(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly messageId: MessageId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem | undefined;
  readonly reactions: ReadonlyArray<ChatPassageReaction>;
}) {
  const { available, react } = useReplyReactions(props.environmentId);
  const reply = available ? reactableReply(props.projectedItem) : null;
  const clearHighlight = useRef<(() => void) | null>(null);
  const hide = () => {
    clearHighlight.current?.();
    clearHighlight.current = null;
  };
  useEffect(() => () => clearHighlight.current?.(), []);
  const show = (passage: AssistantPassage) => {
    hide();
    if (props.threadRef === null) return;
    clearHighlight.current = highlightPassage({
      version: 1,
      ...props.threadRef,
      messageId: props.messageId,
      ...passage,
    });
  };

  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
      {passageReactionChips(props.reactions).map((chip) => (
        <span
          key={chip.key}
          className={cn(
            "inline-flex h-5 min-w-0 max-w-56 items-center gap-1 rounded-sm border border-input ps-1.5 text-2xs text-muted-foreground",
            reply === null ? "pe-1.5" : "pe-0.5",
          )}
          onPointerEnter={() => show(chip.passage)}
          onPointerLeave={hide}
          onFocus={() => show(chip.passage)}
          onBlur={hide}
        >
          <span>{chip.emoji}</span>
          <span className="truncate">{chip.excerpt}</span>
          {reply !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-tiny"
                    variant="ghost-muted"
                    aria-label={chip.removeLabel}
                    onClick={() => {
                      hide();
                      void react(reply, chip.emoji, false, chip.passage);
                    }}
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">{chip.removeLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      ))}
    </div>
  );
}
