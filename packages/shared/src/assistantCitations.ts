import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  AssistantCitation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const CITATION_PROTOCOL = "t3-citation:";
const CITATION_HREF_PREFIX = `${CITATION_PROTOCOL}//v1/`;
// Percent encoding needs up to nine characters per UTF-16 code unit; 16k covers selectors.
const MAX_CITATION_HREF_LENGTH =
  9 * (ASSISTANT_CITATION_MAX_TEXT_LENGTH + ASSISTANT_CITATION_MAX_COMMENT_LENGTH) + 16_000;
const CITATION_LINK = new RegExp(
  String.raw`\[Assistant quote\]\((${CITATION_HREF_PREFIX}[^\s)]{1,${MAX_CITATION_HREF_LENGTH - CITATION_HREF_PREFIX.length}})\)`,
  "g",
);
const decodeCitation = Schema.decodeUnknownOption(AssistantCitation);

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

export function formatAssistantCitationHref(citation: AssistantCitation): string {
  const path = [citation.environmentId, citation.threadId, citation.messageId]
    .map(encodePathPart)
    .join("/");
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

export function parseAssistantCitationHref(href: string): AssistantCitation | null {
  if (!href.startsWith(CITATION_HREF_PREFIX) || href.length > MAX_CITATION_HREF_LENGTH) {
    return null;
  }
  try {
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
    const requiredKeys = ["text", "start", "end", "prefix", "suffix"];
    const comment = url.searchParams.get("comment");
    if (
      url.searchParams.size !== requiredKeys.length + (comment === null ? 0 : 1) ||
      requiredKeys.some((key) => url.searchParams.getAll(key).length !== 1)
    ) {
      return null;
    }
    const start = url.searchParams.get("start") ?? "";
    const end = url.searchParams.get("end") ?? "";
    if (!/^\d{1,16}$/.test(start) || !/^\d{1,16}$/.test(end)) return null;
    return Option.getOrNull(
      decodeCitation({
        version: 1,
        environmentId: decodeURIComponent(parts[0]!),
        threadId: decodeURIComponent(parts[1]!),
        messageId: decodeURIComponent(parts[2]!),
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

export function assistantCitationsToPlainText(prompt: string): string {
  return prompt.replace(CITATION_LINK, (source: string, href: string) => {
    const citation = parseAssistantCitationHref(href);
    if (!citation) return source;
    return citation.comment === undefined
      ? citation.text
      : `${citation.text}\nComment: ${citation.comment}`;
  });
}

/** How an agent reads the time of one of its replies, e.g. `2026-09-04 11:58 UTC`. */
export function formatReplyTimeForProvider(repliedAt: DateTime.Utc): string {
  return `${DateTime.formatIso(repliedAt).slice(0, 16).replace("T", " ")} UTC`;
}

function formatAssistantCitationForProvider(
  citation: AssistantCitation,
  repliedAt: DateTime.Utc | undefined,
): string {
  const time = repliedAt === undefined ? null : formatReplyTimeForProvider(repliedAt);
  const quote = citation.text
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  const comment = citation.comment?.trim();
  return [
    `Quoted from an earlier assistant reply${time ? ` (${time})` : ""}:`,
    quote,
    ...(comment ? ["", `User comment: ${comment}`] : []),
  ].join("\n");
}

// Text that follows a quote block starts its own paragraph; keep the indentation of a next line.
function trimAfterQuoteBlock(text: string): string {
  const rest = text.replace(/^(?:[ \t]*\r?\n)+/, "");
  return rest === text ? text.trimStart() : rest;
}

/**
 * What an agent reads for a prompt: each citation becomes, in place, its quote as a Markdown
 * blockquote followed by the user's comment. `replyCreatedAt` returns the cited reply's time when
 * the caller found it.
 */
export function expandAssistantCitationsForProvider(
  prompt: string,
  replyCreatedAt: (citation: AssistantCitation) => DateTime.Utc | undefined = () => undefined,
): string {
  const matches = collectAssistantCitations(prompt);
  if (matches.length === 0) return prompt;
  const parts: string[] = [];
  let cursor = 0;
  for (const [index, match] of matches.entries()) {
    const before = prompt.slice(cursor, match.start);
    parts.push(
      (index === 0 ? before : trimAfterQuoteBlock(before)).trimEnd(),
      formatAssistantCitationForProvider(match.citation, replyCreatedAt(match.citation)),
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
  const matches = collectAssistantCitations(prompt);
  let text = "";
  let cursor = 0;
  for (const match of matches) {
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
