import type {
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2MessageReaction,
  OrchestrationV2MessageReactionEmoji,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { formatReplyTimeForProvider } from "@t3tools/shared/assistantCitations";
import * as DateTime from "effect/DateTime";

const REPLY_EXCERPT_LENGTH = 60;

export type AssistantReplyItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "assistant_message" }
>;

/** `reply` after the user sets or clears `emoji` on it, or null when nothing changes. */
export function withReaction(
  reply: AssistantReplyItem,
  change: {
    readonly emoji: OrchestrationV2MessageReactionEmoji;
    readonly reacted: boolean;
    readonly goAhead: boolean;
    readonly at: DateTime.Utc;
  },
): AssistantReplyItem | null {
  const { reactions: current = [], ...rest } = reply;
  const existing = current.find((reaction) => reaction.emoji === change.emoji);
  // Setting a reaction again keeps its time, so the agent is told once. Go ahead takes over a
  // silent one because its own message tells the agent.
  const unchanged = change.reacted
    ? existing !== undefined && (existing.goAhead === true || !change.goAhead)
    : existing === undefined;
  if (unchanged) return null;
  const others = current.filter((reaction) => reaction.emoji !== change.emoji);
  const reactions: ReadonlyArray<OrchestrationV2MessageReaction> = change.reacted
    ? [
        ...others,
        { emoji: change.emoji, reactedAt: change.at, ...(change.goAhead ? { goAhead: true } : {}) },
      ]
    : others;
  return reactions.length === 0 ? rest : { ...rest, reactions };
}

/**
 * The latest run that reached the provider before input that arrives at `deliveredAt`. A message
 * that starts a run skips that run: a retried or restarted run tells its reactions again.
 */
export function previousRun(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "userMessageId" | "startedAt">>,
  input: { readonly messageId: MessageId; readonly deliveredAt: DateTime.Utc },
) {
  let previous: (typeof runs)[number] | undefined;
  for (const run of runs) {
    if (
      run.userMessageId !== input.messageId &&
      run.startedAt !== null &&
      DateTime.isLessThan(run.startedAt, input.deliveredAt) &&
      (previous?.startedAt == null || DateTime.isGreaterThan(run.startedAt, previous.startedAt))
    ) {
      previous = run;
    }
  }
  return previous;
}

/** When `run` last gave the provider input before `deliveredAt`: its start or a later steer. */
export function lastInputAt(
  run: Pick<OrchestrationV2Run, "id" | "userMessageId"> & { readonly startedAt: DateTime.Utc },
  messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "id" | "runId" | "role" | "createdAt">
  >,
  input: { readonly messageId: MessageId; readonly deliveredAt: DateTime.Utc },
): DateTime.Utc {
  let latest = run.startedAt;
  for (const message of messages) {
    if (
      message.role === "user" &&
      message.runId === run.id &&
      message.id !== run.userMessageId &&
      message.id !== input.messageId &&
      DateTime.isLessThan(message.createdAt, input.deliveredAt) &&
      DateTime.isGreaterThan(message.createdAt, latest)
    ) {
      latest = message.createdAt;
    }
  }
  return latest;
}

/** When the reply was given, as the timeline dates it. */
function repliedAt(reply: AssistantReplyItem): DateTime.Utc {
  return reply.startedAt ?? reply.updatedAt;
}

/**
 * Reactions the agent has not been told: set after the previous input reached the provider and
 * by the time this one does. Go ahead reactions are told by their own message.
 */
export function pendingReactions(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  window: { readonly after: DateTime.Utc | null; readonly through: DateTime.Utc },
) {
  return items
    .filter((item): item is AssistantReplyItem => item.type === "assistant_message")
    .toSorted((left, right) => DateTime.Order(repliedAt(left), repliedAt(right)))
    .flatMap((reply) =>
      (reply.reactions ?? [])
        .filter(
          (reaction) =>
            reaction.goAhead !== true &&
            (window.after === null || DateTime.isGreaterThan(reaction.reactedAt, window.after)) &&
            DateTime.isLessThanOrEqualTo(reaction.reactedAt, window.through),
        )
        .map((reaction) => ({ reply, reaction })),
    );
}

function replyExcerpt(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.length > REPLY_EXCERPT_LENGTH
    ? `${firstLine.slice(0, REPLY_EXCERPT_LENGTH).trimEnd()}…`
    : firstLine;
}

export function reactionNote(input: {
  readonly reply: AssistantReplyItem;
  readonly reaction: Pick<OrchestrationV2MessageReaction, "emoji">;
}): string {
  const time = formatReplyTimeForProvider(repliedAt(input.reply));
  return `The user reacted ${input.reaction.emoji} to your reply from ${time} ("${replyExcerpt(input.reply.text)}").`;
}
