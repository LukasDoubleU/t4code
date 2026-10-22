import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnItemId,
  type AssistantCitation,
} from "@t3tools/contracts";
import {
  collectAssistantCitations,
  expandAssistantCitationsForProvider,
} from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  citationPassage,
  passageExcerpt,
  passageGoAheadText,
  passageReactionChips,
  selectionToolbarState,
} from "./AssistantPassageReactions.logic";

const itemId = TurnItemId.make("item-reply");

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-passages"),
  messageId: MessageId.make("message-reply"),
  text: "Option B: rewrite the parser.",
  start: 20,
  end: 49,
  prefix: "Option A: patch it. ",
  suffix: "",
  comment: "an earlier comment",
};

const passage = (text: string, start: number) => ({
  text,
  start,
  end: start + text.length,
  prefix: "",
  suffix: "",
});

describe("selectionToolbarState", () => {
  it("offers reactions only on a reply that takes them, on a server that stores them", () => {
    expect(
      selectionToolbarState({ text: "Option B", reactionItemId: itemId, reactionsAvailable: true }),
    ).toEqual({ tooLong: false, citeLabel: "Cite selection in composer", reactionItemId: itemId });
    expect(
      selectionToolbarState({ text: "Option B", reactionItemId: null, reactionsAvailable: true })
        .reactionItemId,
    ).toBeNull();
    expect(
      selectionToolbarState({ text: "Option B", reactionItemId: itemId, reactionsAvailable: false })
        .reactionItemId,
    ).toBeNull();
  });

  it("marks a selection too long for a citation, which reactions store too", () => {
    const state = selectionToolbarState({
      text: "x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1),
      reactionItemId: itemId,
      reactionsAvailable: true,
    });
    expect(state.tooLong).toBe(true);
    expect(state.citeLabel).toBe("Selection is too long to cite");
  });
});

describe("passage Go ahead", () => {
  it("stores the selector without the citation's ids or comment", () => {
    expect(citationPassage(citation)).toEqual({
      text: "Option B: rewrite the parser.",
      start: 20,
      end: 49,
      prefix: "Option A: patch it. ",
      suffix: "",
    });
  });

  it("sends the passage cited with the approval, which the agent reads as a quote", () => {
    const text = passageGoAheadText(citation);
    const [sent] = collectAssistantCitations(text);
    expect(sent?.citation).toEqual({ ...citation, comment: "👍 Go ahead." });
    expect(sent?.source).toBe(text);
    expect(expandAssistantCitationsForProvider(text)).toBe(
      [
        "Quoted from an earlier assistant reply:",
        "> Option B: rewrite the parser.",
        "",
        "User comment: 👍 Go ahead.",
      ].join("\n"),
    );
  });
});

describe("passage chips", () => {
  it("shortens a passage to one line, without splitting a character", () => {
    expect(passageExcerpt("  Keep\n  the cache  ")).toBe("Keep the cache");
    expect(passageExcerpt(`${"a".repeat(31)}👍 and more`)).toBe(`${"a".repeat(31)}👍…`);
  });

  it("lists the reactions in the order of their passages in the reply", () => {
    const chips = passageReactionChips([
      { emoji: "👍", passage: passage("Option B: rewrite the parser.", 20) },
      { emoji: "👎", passage: passage("Option A: patch it.", 0) },
    ]);
    expect(
      chips.map(({ key, emoji, excerpt, removeLabel }) => ({ key, emoji, excerpt, removeLabel })),
    ).toEqual([
      {
        key: "0:19",
        emoji: "👎",
        excerpt: "Option A: patch it.",
        removeLabel: "Remove 👎 on “Option A: patch it.”",
      },
      {
        key: "20:49",
        emoji: "👍",
        excerpt: "Option B: rewrite the parser.",
        removeLabel: "Remove 👍 on “Option B: rewrite the parser.”",
      },
    ]);
  });
});
