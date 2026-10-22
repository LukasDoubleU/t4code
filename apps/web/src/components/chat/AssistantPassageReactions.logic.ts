import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type AssistantCitation,
  type AssistantPassage,
  type TurnItemId,
} from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";

import type { ChatPassageReaction } from "../../types";

const PASSAGE_EXCERPT_LENGTH = 32;

export const PASSAGE_GO_AHEAD_LABEL = "👍 Go ahead with this passage: starts a turn";

/** The passage a citation quotes, as a reaction stores it. */
export function citationPassage(citation: AssistantCitation): AssistantPassage {
  const { text, start, end, prefix, suffix } = citation;
  return { text, start, end, prefix, suffix };
}

/** What Go ahead on a passage sends: the passage cited, with the approval as its comment. */
export function passageGoAheadText(citation: AssistantCitation): string {
  return serializeAssistantCitation(withAssistantCitationComment(citation, "👍 Go ahead."));
}

/**
 * The selection toolbar's buttons. Reactions need a finished reply of the thread itself, which
 * its source marks with the reply's item, and a server that stores them.
 */
export function selectionToolbarState(input: {
  readonly text: string;
  readonly reactionItemId: TurnItemId | null;
  readonly reactionsAvailable: boolean;
}) {
  const tooLong = input.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  return {
    tooLong,
    citeLabel: tooLong ? "Selection is too long to cite" : "Cite selection in composer",
    reactionItemId: input.reactionsAvailable ? input.reactionItemId : null,
  } as const;
}

export function passageExcerpt(text: string): string {
  const characters = Array.from(text.replace(/\s+/g, " ").trim());
  return characters.length > PASSAGE_EXCERPT_LENGTH
    ? `${characters.slice(0, PASSAGE_EXCERPT_LENGTH).join("").trimEnd()}…`
    : characters.join("");
}

/** A chip per passage reaction, in the order the passages appear in the reply. */
export function passageReactionChips(reactions: ReadonlyArray<ChatPassageReaction>) {
  return reactions
    .toSorted((left, right) => left.passage.start - right.passage.start)
    .map((reaction) => {
      const excerpt = passageExcerpt(reaction.passage.text);
      return {
        ...reaction,
        key: `${reaction.passage.start}:${reaction.passage.end}`,
        excerpt,
        removeLabel: `Remove ${reaction.emoji} on “${excerpt}”`,
      };
    });
}
