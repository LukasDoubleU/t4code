import type { AssistantCitation } from "@t3tools/contracts";
import {
  assistantCitationLabel,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { Link } from "@tanstack/react-router";
import { PencilIcon, QuoteIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { useAssistantCitationSourceLink } from "./AssistantCitationQuote";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";

/** A citation in the composer draft. Sent messages render `AssistantCitationQuote` instead. */
export function AssistantCitationChip({
  citation,
  commentEditor,
}: {
  citation: AssistantCitation;
  commentEditor?: {
    open: boolean;
    sourceAnchor?: AssistantCitationSourceAnchor | undefined;
    onOpenChange: (open: boolean) => void;
    onCancel?: () => void;
    onSave: (comment: string) => boolean;
    onSaveAndSend?: (comment: string) => boolean;
    onDraftChange?: (comment: string) => void;
    onRestoreFocus?: () => void;
  };
}) {
  const sourceLink = useAssistantCitationSourceLink(citation);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentPopupRef = useRef<HTMLDivElement>(null);
  const draftCommentRef = useRef<string | null>(null);
  const [unavailableSourceAnchor, setUnavailableSourceAnchor] =
    useState<AssistantCitationSourceAnchor | null>(null);
  const commentOpen = commentEditor?.open ?? false;
  const sourceAnchor = commentEditor?.sourceAnchor;
  const activeSourceAnchor = sourceAnchor === unavailableSourceAnchor ? undefined : sourceAnchor;
  useEffect(() => {
    if (!commentOpen) draftCommentRef.current = null;
  }, [commentOpen]);
  const settleDraftOnClose = (reason: string): boolean => {
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason,
      draft: draftCommentRef.current,
      savedComment: citation.comment,
    });
    if (dismissal.kind === "commit") return commentEditor?.onSave(dismissal.comment) ?? true;
    return dismissal.kind !== "keep-open";
  };
  const onSourceUnavailable = useEffectEvent(() => {
    if (!sourceAnchor) return;
    if (settleDraftOnClose("none")) {
      commentEditor?.onOpenChange(false);
    } else {
      setUnavailableSourceAnchor(sourceAnchor);
    }
  });
  useEffect(() => {
    if (!commentOpen || sourceAnchor === unavailableSourceAnchor) return;
    const anchor = sourceAnchor ?? findAssistantCitationSourceAnchor(document, citation);
    if (!anchor) return;
    return observeAssistantCitationCommentSource({
      anchor,
      citation,
      onUnavailable: onSourceUnavailable,
    });
  }, [citation, commentOpen, sourceAnchor, unavailableSourceAnchor]);
  const popupAnchor = activeSourceAnchor
    ? {
        contextElement: activeSourceAnchor.source,
        getBoundingClientRect: () => {
          const rects = activeSourceAnchor.range.getClientRects();
          return rects.item(rects.length - 1) ?? activeSourceAnchor.range.getBoundingClientRect();
        },
      }
    : undefined;
  const label = assistantCitationLabel(citation);
  const composerSourceLink = (
    <Link
      {...sourceLink}
      data-markdown-copy={serializeAssistantCitation(citation)}
      className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline focus-visible:outline-2 focus-visible:outline-foreground"
      aria-label={`View cited assistant text: ${label}`}
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]">{label}</ContextChipLabel>
    </Link>
  );
  return (
    <ContextChip
      kind="citation"
      contentEditable={false}
      data-assistant-citation-chip="true"
      data-markdown-copy={serializeAssistantCitation(citation)}
    >
      {composerSourceLink}
      {commentEditor ? (
        <Popover
          open={commentEditor.open}
          onOpenChange={(open, eventDetails) => {
            if (!open && !settleDraftOnClose(eventDetails.reason)) {
              eventDetails.cancel();
              return;
            }
            commentEditor.onOpenChange(open);
          }}
        >
          <PopoverTrigger
            aria-label={citation.comment ? "Edit citation comment" : "Add comment to citation"}
            data-citation-comment-trigger="true"
            render={<ContextChipAction />}
          >
            <PencilIcon aria-hidden="true" />
          </PopoverTrigger>
          {commentEditor.open ? (
            <PopoverPopup
              {...composerFloatingLayerProps}
              side={activeSourceAnchor ? "bottom" : "top"}
              align="end"
              anchor={popupAnchor}
              initialFocus={() => {
                commentInputRef.current?.focus({ preventScroll: true });
                return false;
              }}
              finalFocus={
                commentEditor.onRestoreFocus
                  ? () => {
                      const activeElement = document.activeElement;
                      if (
                        activeElement === document.body ||
                        (activeElement !== null && commentPopupRef.current?.contains(activeElement))
                      ) {
                        commentEditor.onRestoreFocus?.();
                      }
                      return false;
                    }
                  : undefined
              }
              ref={commentPopupRef}
              aria-label="Edit citation comment"
              width="md"
              padding="compact"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AssistantCitationCommentEditor
                key={serializeAssistantCitation(citation)}
                citation={citation}
                inputRef={commentInputRef}
                onDraftChange={(comment) => {
                  draftCommentRef.current = comment;
                  commentEditor.onDraftChange?.(comment);
                }}
                onSubmit={(comment) => {
                  if (!commentEditor.onSave(comment)) return false;
                  commentEditor.onOpenChange(false);
                  return true;
                }}
                {...(commentEditor.onSaveAndSend
                  ? {
                      onSubmitAndSend: (comment: string) => {
                        if (!commentEditor.onSaveAndSend?.(comment)) return false;
                        commentEditor.onOpenChange(false);
                        return true;
                      },
                    }
                  : {})}
                onCancel={() => {
                  if (commentEditor.onCancel) {
                    commentEditor.onCancel();
                  } else {
                    commentEditor.onOpenChange(false);
                  }
                }}
              />
            </PopoverPopup>
          ) : null}
        </Popover>
      ) : null}
    </ContextChip>
  );
}
