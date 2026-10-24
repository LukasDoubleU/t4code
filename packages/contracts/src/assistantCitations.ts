import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EnvironmentId, MessageId, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const ASSISTANT_CITATION_MAX_TEXT_LENGTH = 8_000;
export const ASSISTANT_CITATION_MAX_COMMENT_LENGTH = 8_000;
export const ASSISTANT_CITATION_CONTEXT_LENGTH = 32;
export const ASSISTANT_REPLY_EXCERPT_LENGTH = 60;

const AssistantPassageFields = {
  text: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(ASSISTANT_CITATION_MAX_TEXT_LENGTH),
  ),
  start: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  end: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  prefix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
  suffix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
};

/**
 * A passage of an assistant reply as the user selected it: its text, and its offsets and context
 * in the reply's rendered text, which find it again after the reply re-renders. Positions are
 * UTF-16 offsets, not Markdown offsets.
 */
export const AssistantPassage = Schema.Struct(AssistantPassageFields).check(
  Schema.makeFilter((passage) => passage.end > passage.start && passage.text.trim().length > 0),
);
export type AssistantPassage = typeof AssistantPassage.Type;

export const AssistantCitation = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId.check(Schema.isMaxLength(512)),
  threadId: ThreadId.check(Schema.isMaxLength(512)),
  messageId: MessageId.check(Schema.isMaxLength(512)),
  comment: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_MAX_COMMENT_LENGTH)),
  ),
  ...AssistantPassageFields,
}).check(
  Schema.makeFilter((citation) => citation.end > citation.start && citation.text.trim().length > 0),
);
export type AssistantCitation = typeof AssistantCitation.Type;

/**
 * A whole assistant reply a user message answers. It names the reply by its time and first line
 * instead of quoting it: the agent already has the reply.
 */
export const AssistantReplyReference = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId.check(Schema.isMaxLength(512)),
  threadId: ThreadId.check(Schema.isMaxLength(512)),
  messageId: MessageId.check(Schema.isMaxLength(512)),
  /** The time the reply's footer shows, as an ISO string. */
  repliedAt: Schema.String.check(Schema.isMaxLength(64)),
  /** The reply's first line, cut to `ASSISTANT_REPLY_EXCERPT_LENGTH` and an ellipsis. */
  excerpt: Schema.String.check(Schema.isMaxLength(ASSISTANT_REPLY_EXCERPT_LENGTH + 1)),
}).check(Schema.makeFilter((reference) => Option.isSome(DateTime.make(reference.repliedAt))));
export type AssistantReplyReference = typeof AssistantReplyReference.Type;
