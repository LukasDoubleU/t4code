import type { MessageId, OrchestrationV2ConversationMessage, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  expandAssistantCitationsForProvider,
} from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";

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

/**
 * The text a provider receives for a user message, whether it starts a turn or steers one. The
 * stored message keeps its citation links, so clients can still render and navigate them.
 */
export const providerMessageText = Effect.fn("orchestrationV2.providerMessageText")(function* (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  message: Pick<OrchestrationV2ConversationMessage, "threadId" | "text" | "context">,
) {
  const sourceIds = citedReplyIds(message.text, message.threadId);
  const sources =
    sourceIds.length === 0
      ? []
      : (yield* projections.getThreadRecords(message.threadId, ["messages"], {
          messageIds: sourceIds,
          messageRoles: ["assistant"],
        })).messages;
  return projectComposerContextForProvider({
    text: readableCitations(message.text, message.threadId, sources),
    records: message.context?.records ?? [],
  });
});
