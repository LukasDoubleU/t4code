import type { AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import {
  assistantCitationHash,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { findRevealRef } from "./markdownFindContext";

/** Props for a link that reveals the cited text in its assistant reply. */
export function useAssistantCitationSourceLink(citation: AssistantCitation) {
  const navigate = useNavigate();
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: assistantCitationHash(citation),
    resetScroll: false,
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      void navigate(assistantCitationNavigation(citation));
    },
  };
}

/** A citation in a sent message: the quote, two lines until expanded, then the user's comment. */
export function AssistantCitationQuote({ citation }: { citation: AssistantCitation }) {
  const sourceLink = useAssistantCitationSourceLink(citation);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const quoteRef = (element: HTMLSpanElement | null) => {
    if (!element) return;
    const stopReveal = revealRef(element);
    // Measured only while clamped; expanding keeps the last answer so "Show less" stays.
    const stopMeasure = expanded
      ? undefined
      : observeResize(element, () => {
          setOverflows(element.scrollHeight > element.clientHeight + 1);
        });
    return () => {
      stopReveal?.();
      stopMeasure?.();
    };
  };
  const folded = overflows && !expanded;
  return (
    <span className="my-1.5 block" data-markdown-copy={serializeAssistantCitation(citation)}>
      <Link
        {...sourceLink}
        title="Go to source"
        className="chat-markdown-citation block rounded-sm border-l-2 border-border pl-3 text-muted-foreground no-underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground"
      >
        <span
          ref={quoteRef}
          className={cn("block whitespace-pre-wrap wrap-break-word", !expanded && "line-clamp-2")}
          data-thread-find-fold={folded ? "" : undefined}
        >
          {citation.text.trim()}
        </span>
      </Link>
      {overflows ? (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-expanded={expanded}
          data-scroll-anchor-ignore
          onClick={() => setExpanded((value) => !value)}
          className="ml-1"
        >
          {expanded ? "Show less" : "Show full quote"}
        </Button>
      ) : null}
      {citation.comment ? (
        <span className="mt-1 block whitespace-pre-wrap wrap-break-word">{citation.comment}</span>
      ) : null}
    </span>
  );
}
