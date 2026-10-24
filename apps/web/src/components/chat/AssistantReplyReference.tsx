import type { AssistantReplyReference } from "@t3tools/contracts";
import { serializeAssistantReplyReference } from "@t3tools/shared/assistantCitations";
import { Link } from "@tanstack/react-router";
import { ReplyIcon, XIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { useAssistantCitationSourceLink } from "./AssistantCitationQuote";
import { replyReferenceLabel } from "./AssistantReactions.logic";

function useReplyReferenceLabel(reference: AssistantReplyReference): string {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return replyReferenceLabel(reference, timestampFormat);
}

/** The reply a draft answers. Sent messages render `AssistantReplyReferenceLink` instead. */
export function AssistantReplyChip(props: {
  readonly reference: AssistantReplyReference;
  readonly onRemove: () => void;
}) {
  const sourceLink = useAssistantCitationSourceLink(props.reference);
  const label = useReplyReferenceLabel(props.reference);
  const markdown = serializeAssistantReplyReference(props.reference);
  return (
    <ContextChip kind="citation" contentEditable={false} data-markdown-copy={markdown}>
      <Link
        {...sourceLink}
        className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline focus-visible:outline-2 focus-visible:outline-foreground"
        aria-label={`Go to the reply: ${label}`}
      >
        <ReplyIcon aria-hidden="true" />
        <ContextChipLabel className="max-w-[20em]">{label}</ContextChipLabel>
      </Link>
      <ContextChipAction aria-label="Remove reply reference" onClick={props.onRemove}>
        <XIcon aria-hidden="true" />
      </ContextChipAction>
    </ContextChip>
  );
}

/** The reply a sent message answers, above its text. Clicking it goes to the reply. */
export function AssistantReplyReferenceLink({
  reference,
}: {
  readonly reference: AssistantReplyReference;
}) {
  const sourceLink = useAssistantCitationSourceLink(reference);
  const label = useReplyReferenceLabel(reference);
  return (
    <span className="mb-1.5 block" data-markdown-copy={serializeAssistantReplyReference(reference)}>
      <Link
        {...sourceLink}
        title="Go to the reply"
        className="chat-markdown-citation inline-flex max-w-full items-center gap-1.5 rounded-sm text-muted-foreground text-xs no-underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground"
      >
        <ReplyIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </Link>
    </span>
  );
}
