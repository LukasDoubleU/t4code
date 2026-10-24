import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  ASSISTANT_REPLY_EXCERPT_LENGTH,
  AssistantCitation,
  AssistantReplyReference,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const CITATION_PROTOCOL = "t3-citation:";
const CITATION_HREF_PREFIX = `${CITATION_PROTOCOL}//v1/`;
// Percent encoding needs up to nine characters per UTF-16 code unit; 16k covers selectors.
const MAX_CITATION_HREF_LENGTH =
  9 * (ASSISTANT_CITATION_MAX_TEXT_LENGTH + ASSISTANT_CITATION_MAX_COMMENT_LENGTH) + 16_000;
const referenceLink = (label: string) =>
  new RegExp(
    String.raw`\[${label}\]\((${CITATION_HREF_PREFIX}[^\s)]{1,${MAX_CITATION_HREF_LENGTH - CITATION_HREF_PREFIX.length}})\)`,
    "g",
  );
const CITATION_LINK = referenceLink("Assistant quote");
const REPLY_LINK = referenceLink("Assistant reply");
const decodeCitation = Schema.decodeUnknownOption(AssistantCitation);
const decodeReplyReference = Schema.decodeUnknownOption(AssistantReplyReference);

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function withAssistantCitationComment(
  citation: AssistantCitation,
  comment: string,
): AssistantCitation {
  const { comment: _previousComment, ...source } = citation;
  const trimmedComment = comment.trim();
  return trimmedComment ? { ...source, comment: trimmedComment } : source;
}

function referenceHrefPath(
  source: Pick<AssistantCitation, "environmentId" | "threadId" | "messageId">,
): string {
  return [source.environmentId, source.threadId, source.messageId].map(encodePathPart).join("/");
}

export function formatAssistantCitationHref(citation: AssistantCitation): string {
  const path = referenceHrefPath(citation);
  const query = new URLSearchParams({
    text: citation.text,
    start: String(citation.start),
    end: String(citation.end),
    prefix: citation.prefix,
    suffix: citation.suffix,
  });
  if (citation.comment !== undefined) query.set("comment", citation.comment);
  return `${CITATION_HREF_PREFIX}${path}?${query}`;
}

/** The URL of a citation link and the reply it names; throws on a malformed URL. */
function parseReferenceUrl(href: string) {
  if (!href.startsWith(CITATION_HREF_PREFIX) || href.length > MAX_CITATION_HREF_LENGTH) {
    return null;
  }
  const url = new URL(href);
  const parts = url.pathname.slice(1).split("/");
  if (
    url.protocol !== CITATION_PROTOCOL ||
    url.hostname !== "v1" ||
    parts.length !== 3 ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }
  return {
    url,
    source: {
      version: 1,
      environmentId: decodeURIComponent(parts[0]!),
      threadId: decodeURIComponent(parts[1]!),
      messageId: decodeURIComponent(parts[2]!),
    },
  };
}

function hasExactlyKeys(url: URL, keys: ReadonlyArray<string>, optional = 0): boolean {
  return (
    url.searchParams.size === keys.length + optional &&
    keys.every((key) => url.searchParams.getAll(key).length === 1)
  );
}

export function parseAssistantCitationHref(href: string): AssistantCitation | null {
  try {
    const parsed = parseReferenceUrl(href);
    if (!parsed) return null;
    const { url, source } = parsed;
    const comment = url.searchParams.get("comment");
    if (
      !hasExactlyKeys(url, ["text", "start", "end", "prefix", "suffix"], comment === null ? 0 : 1)
    ) {
      return null;
    }
    const start = url.searchParams.get("start") ?? "";
    const end = url.searchParams.get("end") ?? "";
    if (!/^\d{1,16}$/.test(start) || !/^\d{1,16}$/.test(end)) return null;
    return Option.getOrNull(
      decodeCitation({
        ...source,
        text: url.searchParams.get("text"),
        start: Number(start),
        end: Number(end),
        prefix: url.searchParams.get("prefix"),
        suffix: url.searchParams.get("suffix"),
        ...(comment === null ? {} : { comment }),
      }),
    );
  } catch {
    return null;
  }
}

export function formatAssistantReplyHref(reference: AssistantReplyReference): string {
  const query = new URLSearchParams({ repliedAt: reference.repliedAt, excerpt: reference.excerpt });
  return `${CITATION_HREF_PREFIX}${referenceHrefPath(reference)}?${query}`;
}

export function parseAssistantReplyHref(href: string): AssistantReplyReference | null {
  try {
    const parsed = parseReferenceUrl(href);
    if (!parsed || !hasExactlyKeys(parsed.url, ["repliedAt", "excerpt"])) return null;
    return Option.getOrNull(
      decodeReplyReference({
        ...parsed.source,
        repliedAt: parsed.url.searchParams.get("repliedAt"),
        excerpt: parsed.url.searchParams.get("excerpt"),
      }),
    );
  } catch {
    return null;
  }
}

/** A link to an assistant reply: a passage of it, or the whole reply a message answers. */
export type AssistantReference = AssistantCitation | AssistantReplyReference;

export function isAssistantReplyReference(
  reference: AssistantReference,
): reference is AssistantReplyReference {
  return "repliedAt" in reference;
}

/** A reply's first non-blank line with its whitespace collapsed, cut short with an ellipsis. */
export function assistantReplyExcerpt(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.length > ASSISTANT_REPLY_EXCERPT_LENGTH
    ? `${firstLine.slice(0, ASSISTANT_REPLY_EXCERPT_LENGTH).trimEnd()}…`
    : firstLine;
}

export function serializeAssistantReplyReference(reference: AssistantReplyReference): string {
  return `[Assistant reply](${formatAssistantReplyHref(reference)})`;
}

export function assistantCitationLabel(citation: AssistantCitation): string {
  const preview = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ");
  return preview.length > 64 ? `${preview.slice(0, 64)}…` : preview;
}

export function serializeAssistantCitation(citation: AssistantCitation): string {
  return `[Assistant quote](${formatAssistantCitationHref(citation)})`;
}

export function collectAssistantCitations(text: string) {
  const citations: { citation: AssistantCitation; source: string; start: number; end: number }[] =
    [];
  for (const match of text.matchAll(CITATION_LINK)) {
    const citation = parseAssistantCitationHref(match[1]!);
    if (!citation) continue;
    citations.push({
      citation,
      source: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return citations;
}

export function collectAssistantReplyReferences(text: string) {
  const references: {
    reference: AssistantReplyReference;
    source: string;
    start: number;
    end: number;
  }[] = [];
  for (const match of text.matchAll(REPLY_LINK)) {
    const reference = parseAssistantReplyHref(match[1]!);
    if (!reference) continue;
    references.push({
      reference,
      source: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return references;
}

/** Citations and reply references in the order they appear in `text`. */
function collectAssistantReferences(text: string) {
  return [
    ...collectAssistantCitations(text).map((match) => ({ kind: "quote" as const, ...match })),
    ...collectAssistantReplyReferences(text).map((match) => ({ kind: "reply" as const, ...match })),
  ].sort((left, right) => left.start - right.start);
}

/** Titles and previews read a citation as its quote; a reply reference is left out. */
export function assistantCitationsToPlainText(prompt: string): string {
  return prompt
    .replace(CITATION_LINK, (source: string, href: string) => {
      const citation = parseAssistantCitationHref(href);
      if (!citation) return source;
      return citation.comment === undefined
        ? citation.text
        : `${citation.text}\nComment: ${citation.comment}`;
    })
    .replace(REPLY_LINK, (source: string, href: string) =>
      parseAssistantReplyHref(href) ? "" : source,
    );
}

/** How an agent reads the time of one of its replies, e.g. `2026-09-04 11:58 UTC`. */
export function formatReplyTimeForProvider(repliedAt: DateTime.Utc): string {
  return `${DateTime.formatIso(repliedAt).slice(0, 16).replace("T", " ")} UTC`;
}

/** Text of an assistant reply as the Markdown blockquote an agent reads. */
export function formatQuoteForProvider(text: string): string {
  return text
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

function formatAssistantCitationForProvider(
  citation: AssistantCitation,
  repliedAt: DateTime.Utc | undefined,
): string {
  const time = repliedAt === undefined ? null : formatReplyTimeForProvider(repliedAt);
  const comment = citation.comment?.trim();
  return [
    `Quoted from an earlier assistant reply${time ? ` (${time})` : ""}:`,
    formatQuoteForProvider(citation.text),
    ...(comment ? ["", `User comment: ${comment}`] : []),
  ].join("\n");
}

function formatAssistantReplyForProvider(
  reference: AssistantReplyReference,
  repliedAt: DateTime.Utc | undefined,
): string {
  const time = formatReplyTimeForProvider(repliedAt ?? DateTime.makeUnsafe(reference.repliedAt));
  const excerpt = reference.excerpt ? ` ("${reference.excerpt}")` : "";
  return `Reply to your message from ${time}${excerpt}:`;
}

// Text that follows a quote block starts its own paragraph; keep the indentation of a next line.
function trimAfterQuoteBlock(text: string): string {
  const rest = text.replace(/^(?:[ \t]*\r?\n)+/, "");
  return rest === text ? text.trimStart() : rest;
}

/**
 * What an agent reads for a prompt: each citation becomes, in place, its quote as a Markdown
 * blockquote followed by the user's comment, and a reply reference names the reply by its time
 * and first line. `replyCreatedAt` returns the reply's time when the caller found it; a reply
 * reference falls back to the time it carries.
 */
export function expandAssistantCitationsForProvider(
  prompt: string,
  replyCreatedAt: (
    reply: Pick<AssistantCitation, "threadId" | "messageId">,
  ) => DateTime.Utc | undefined = () => undefined,
): string {
  const matches = collectAssistantReferences(prompt);
  if (matches.length === 0) return prompt;
  const parts: string[] = [];
  let cursor = 0;
  for (const [index, match] of matches.entries()) {
    const before = prompt.slice(cursor, match.start);
    parts.push(
      (index === 0 ? before : trimAfterQuoteBlock(before)).trimEnd(),
      match.kind === "quote"
        ? formatAssistantCitationForProvider(match.citation, replyCreatedAt(match.citation))
        : formatAssistantReplyForProvider(match.reference, replyCreatedAt(match.reference)),
    );
    cursor = match.end;
  }
  parts.push(trimAfterQuoteBlock(prompt.slice(cursor)));
  return parts.filter((part) => part.length > 0).join("\n\n");
}

function escapeMarkdownText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()#+.!|~-]/g, "\\$&");
}

export function renderAssistantCitationsAsText(prompt: string): string {
  const matches = collectAssistantReferences(prompt);
  let text = "";
  let cursor = 0;
  for (const match of matches) {
    if (match.kind === "reply") {
      text += `${prompt.slice(cursor, match.start)}Replying to “${escapeMarkdownText(match.reference.excerpt)}”\n\n`;
      cursor = match.end;
      continue;
    }
    const quote = escapeMarkdownText(match.citation.text);
    text += `${prompt.slice(cursor, match.start)}\n\n> Assistant quote:\n${quote
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n\n`;
    if (match.citation.comment !== undefined) {
      text += `Comment: ${escapeMarkdownText(match.citation.comment)}\n\n`;
    }
    cursor = match.end;
  }
  return text + prompt.slice(cursor);
}
