import type { MessageId, OrchestrationV2ConversationMessage, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  expandAssistantCitationsForProvider,
} from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { lastInputAt, pendingReactions, previousRun, reactionNote } from "./messageReactions.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";

/** The replies in `threadId` that `text` cites; the readable form shows their times. */
export function citedReplyIds(text: string, threadId: ThreadId): ReadonlyArray<MessageId> {
  const ids = new Set<MessageId>();
  for (const { citation } of collectAssistantCitations(text)) {
    if (citation.threadId === threadId) ids.add(citation.messageId);
  }
  return [...ids];
}

/** `text` of a message in `threadId` with each citation as the quote and comment agents read. */
export function readableCitations(
  text: string,
  threadId: ThreadId,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): string {
  return expandAssistantCitationsForProvider(text, (citation) => {
    if (citation.threadId !== threadId) return undefined;
    const source = messages.find(
      (message) => message.id === citation.messageId && message.role === "assistant",
    );
    return source?.createdAt;
  });
}

/** One line per reaction the user set since the provider last got input in this thread. */
const pendingReactionNotes = Effect.fn("orchestrationV2.pendingReactionNotes")(function* (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  message: Pick<OrchestrationV2ConversationMessage, "id" | "threadId">,
  deliveredAt: DateTime.Utc,
) {
  const records = yield* projections.getThreadRecords(message.threadId, ["runs", "turnItems"], {
    turnItemTypes: ["assistant_message"],
    reactedTurnItemsOnly: true,
  });
  const replies = records.turnItems.filter(
    (item) => item.type === "assistant_message" && item.reactions !== undefined,
  );
  if (replies.length === 0) return [];
  const input = { messageId: message.id, deliveredAt };
  const previous = previousRun(records.runs, input);
  const after =
    previous?.startedAt == null
      ? null
      : lastInputAt(
          { ...previous, startedAt: previous.startedAt },
          (yield* projections.getThreadRecords(message.threadId, ["messages"], {
            messageRunIds: [previous.id],
            messageRoles: ["user"],
          })).messages,
          input,
        );
  return pendingReactions(replies, { after, through: deliveredAt }).map(reactionNote);
});

/**
 * The text a provider receives for a user message, whether it starts a turn or steers one. The
 * stored message keeps its citation links, so clients can still render and navigate them.
 * `deliveredAt` is when the message reaches the provider: its run's start, or its steer.
 */
export const providerMessageText = Effect.fn("orchestrationV2.providerMessageText")(function* (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  message: Pick<OrchestrationV2ConversationMessage, "id" | "threadId" | "text" | "context">,
  deliveredAt: DateTime.Utc,
) {
  const sourceIds = citedReplyIds(message.text, message.threadId);
  const sources =
    sourceIds.length === 0
      ? []
      : (yield* projections.getThreadRecords(message.threadId, ["messages"], {
          messageIds: sourceIds,
          messageRoles: ["assistant"],
        })).messages;
  const text = projectComposerContextForProvider({
    text: readableCitations(message.text, message.threadId, sources),
    records: message.context?.records ?? [],
  });
  const reactions = yield* pendingReactionNotes(projections, message, deliveredAt);
  return reactions.length === 0 ? text : `${reactions.join("\n")}\n\n${text}`;
});
