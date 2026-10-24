import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProjectIconOverride } from "./project.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";

function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const ThreadMetadataTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "New concise display title. Required only when action is rename.",
});

const ThreadMetadataClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256))
  .check(
    Schema.makeFilter((value) =>
      hasOnlyPairedSurrogates(value)
        ? true
        : "clientRequestId must contain valid paired Unicode surrogates.",
    ),
  )
  .annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

const ThreadMetadataMcpPullRequestUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) =>
    isHttpUrl(value) ? true : "Pull request URL must be a well-formed HTTP(S) URL.",
  ),
).annotate({
  description: "Canonical HTTP(S) pull request URL, including self-hosted repository URLs.",
});

export const ThreadMetadataMcpAction = Schema.Literals([
  "rename",
  "regenerate_title",
  "link_pull_request",
  "unlink_pull_request",
  "set_icon",
  "clear_icon",
]).annotate({
  description:
    "Metadata mutation: rename, regenerate_title, link_pull_request, unlink_pull_request, set_icon, or clear_icon.",
});
export type ThreadMetadataMcpAction = typeof ThreadMetadataMcpAction.Type;

export const ThreadMetadataMcpPullRequest = Schema.Struct({
  repository: TrimmedNonEmptyString.annotate({
    description: "Repository name as owner/name.",
  }),
  number: PositiveInt.annotate({ description: "Pull request number." }),
  url: ThreadMetadataMcpPullRequestUrl,
});
export type ThreadMetadataMcpPullRequest = typeof ThreadMetadataMcpPullRequest.Type;

export const ThreadMetadataMcpUpdateInput = Schema.Struct({
  threadId: Schema.optional(ThreadId).annotate({
    description: "Thread to update. Omit to update the calling thread.",
  }),
  action: ThreadMetadataMcpAction,
  title: Schema.optional(ThreadMetadataTitle),
  pullRequest: Schema.optional(ThreadMetadataMcpPullRequest).annotate({
    description: "Pull request to link. Required only when action is link_pull_request.",
  }),
  icon: Schema.optional(ProjectIconOverride).annotate({
    description:
      'The thread\'s own icon, shown instead of its project\'s. Required only when action is set_icon: {"kind":"emoji","emoji":"<one emoji>"}, {"kind":"lucide","name":"<lucide icon name in kebab-case>","color":"<color>"}, or {"kind":"monogram","text":"<one or two letters>","color":"<color>"}.',
  }),
  clientRequestId: Schema.optional(ThreadMetadataClientRequestId),
}).check(
  Schema.makeFilter((input) => {
    const extras = [
      input.title === undefined ? null : "title",
      input.pullRequest === undefined ? null : "pullRequest",
      input.icon === undefined ? null : "icon",
    ].filter((field) => field !== null);
    const required = {
      rename: "title",
      link_pull_request: "pullRequest",
      set_icon: "icon",
      regenerate_title: null,
      unlink_pull_request: null,
      clear_icon: null,
    }[input.action];
    if (required !== null && !extras.includes(required)) {
      return `${input.action} requires ${required}.`;
    }
    const rejected = extras.filter((field) => field !== required);
    return rejected.length === 0
      ? true
      : `${input.action} does not accept ${rejected.join(" or ")}.`;
  }),
);
export type ThreadMetadataMcpUpdateInput = typeof ThreadMetadataMcpUpdateInput.Type;

export const ThreadMetadataMcpUpdateResult = Schema.Struct({
  threadId: ThreadId,
  action: ThreadMetadataMcpAction,
  commandId: CommandId,
  sequence: NonNegativeInt,
  title: Schema.String,
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  /** The thread's own icon; null when it shows its project's. */
  icon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  updatedAt: IsoDateTime,
});
export type ThreadMetadataMcpUpdateResult = typeof ThreadMetadataMcpUpdateResult.Type;

export const ThreadAttentionMcpInput = Schema.Struct({
  reason: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description:
        "One line saying what you need from the user: a decision, or an action only they can take.",
    }),
  ),
  clear: Schema.optional(
    Schema.Boolean.annotate({
      description: "Pass true instead of reason to clear this thread's mark once it is resolved.",
    }),
  ),
}).check(
  Schema.makeFilter((input) =>
    (input.reason !== undefined) !== (input.clear === true)
      ? true
      : "Pass either reason, or clear=true.",
  ),
);
export type ThreadAttentionMcpInput = typeof ThreadAttentionMcpInput.Type;

export const ThreadAttentionMcpResult = Schema.Struct({
  threadId: ThreadId,
  attention: Schema.NullOr(Schema.Struct({ reason: Schema.String, requestedAt: IsoDateTime })),
});
export type ThreadAttentionMcpResult = typeof ThreadAttentionMcpResult.Type;
