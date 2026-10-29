import { isUserAuthoredMessage } from "@t3tools/client-runtime/state/thread-catch-up";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userAuthored: boolean;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

/** One strip on the rail: a single turn, or consecutive turns grouped so a long thread fits. */
export interface TimelineMinimapMark {
  readonly id: string;
  readonly firstItemIndex: number;
  /** Never empty. */
  readonly items: ReadonlyArray<TimelineMinimapItem>;
}

export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userAuthored: isUserAuthoredMessage(row.message),
      userText: row.message.text,
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

const markdownPreviewParser = unified().use(remarkParse).use(remarkGfm).freeze();

const INLINE_PARENT_TYPES = new Set<Nodes["type"]>([
  "paragraph",
  "heading",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
]);

function markdownNodeText(node: Nodes): string {
  if (node.type === "html") {
    return node.value
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<\/?([a-z][\w-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (_, tag: string) =>
        /^(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|th|thead|tr|ul)$/i.test(
          tag,
        )
          ? " "
          : "",
      );
  }
  if (node.type === "break") return " ";
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (!("children" in node)) return "";
  const separator = INLINE_PARENT_TYPES.has(node.type) ? "" : " ";
  const text = node.children.map(markdownNodeText).join(separator);
  // A thread autolink's only text is its URL.
  return node.type === "link" && parseThreadLinkHref(text) !== null ? "a thread" : text;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

function itemsToMarks(
  items: ReadonlyArray<TimelineMinimapItem>,
  start: number,
  end: number,
  partCount: number,
  marks: TimelineMinimapMark[],
) {
  const length = end - start;
  for (let part = 0; part < partCount; part += 1) {
    const partStart = start + Math.floor((part * length) / partCount);
    const partEnd = start + Math.floor(((part + 1) * length) / partCount);
    const first = items[partStart];
    if (first)
      marks.push({
        id: first.id,
        firstItemIndex: partStart,
        items: items.slice(partStart, partEnd),
      });
  }
}

/**
 * Fits the turns into `capacity` marks. The user's own messages stay single marks because
 * they are what people jump to; the runs of agent and scheduled turns between them are
 * split into groups of the smallest size that fits. Only when the user's own messages
 * alone do not fit is the whole thread split into even groups.
 */
export function groupTimelineMinimapItems(
  items: ReadonlyArray<TimelineMinimapItem>,
  capacity: number | null,
): TimelineMinimapMark[] {
  const marks: TimelineMinimapMark[] = [];
  if (capacity === null || items.length <= capacity) {
    itemsToMarks(items, 0, items.length, items.length, marks);
    return marks;
  }
  const limit = Math.max(1, capacity);

  const runs: Array<{ readonly start: number; readonly end: number }> = [];
  let authoredCount = 0;
  let runStart: number | null = null;
  for (const [index, item] of items.entries()) {
    if (!item.userAuthored) {
      runStart ??= index;
      continue;
    }
    authoredCount += 1;
    if (runStart !== null) runs.push({ start: runStart, end: index });
    runStart = null;
  }
  if (runStart !== null) runs.push({ start: runStart, end: items.length });

  const runBudget = limit - authoredCount;
  if (runBudget < runs.length) {
    itemsToMarks(items, 0, items.length, limit, marks);
    return marks;
  }

  const partsFor = (groupSize: number) =>
    runs.reduce((total, run) => total + Math.ceil((run.end - run.start) / groupSize), 0);
  let low = 1;
  let high = Math.max(1, ...runs.map((run) => run.end - run.start));
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (partsFor(middle) <= runBudget) high = middle;
    else low = middle + 1;
  }

  let index = 0;
  for (const run of [...runs, { start: items.length, end: items.length }]) {
    // The user's own messages between runs.
    for (; index < run.start; index += 1) itemsToMarks(items, index, index + 1, 1, marks);
    if (run.end > run.start) {
      itemsToMarks(items, run.start, run.end, Math.ceil((run.end - run.start) / low), marks);
    }
    index = run.end;
  }
  return marks;
}

export type TimelineMinimapPreview =
  | {
      readonly kind: "turn";
      readonly userText: string | null;
      readonly assistantText: string | null;
    }
  | {
      readonly kind: "group";
      readonly turnCount: number;
      readonly firstUserText: string | null;
      readonly lastUserText: string | null;
    };

export function resolveTimelineMinimapPreview(
  mark: TimelineMinimapMark | null,
): TimelineMinimapPreview | null {
  const first = mark?.items[0];
  const last = mark?.items.at(-1);
  if (!mark || !first || !last) return null;
  if (mark.items.length > 1) {
    return {
      kind: "group",
      turnCount: mark.items.length,
      firstUserText: compactMinimapPreview(first.userText),
      lastUserText: compactMinimapPreview(last.userText),
    };
  }
  return {
    kind: "turn",
    userText: compactMinimapPreview(first.userText),
    // The tooltip shows three lines; bound parsing work while long responses stream.
    assistantText: compactMinimapPreview(
      first.assistantText === null
        ? null
        : markdownNodeText(markdownPreviewParser.parse(first.assistantText.slice(0, 1_500))),
    ),
  };
}
