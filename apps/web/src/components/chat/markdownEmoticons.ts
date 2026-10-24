import { findEmoticons } from "@t3tools/shared/emoticons";

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const VERBATIM_TAGS = new Set([
  "a",
  "code",
  "kbd",
  "math",
  "pre",
  "samp",
  "script",
  "style",
  "svg",
]);

function emoticonParts(text: string): HastNode[] | null {
  const matches = findEmoticons(text);
  if (matches.length === 0) return null;
  const parts: HastNode[] = [];
  let last = 0;
  for (const match of matches) {
    if (match.start > last) parts.push({ type: "text", value: text.slice(last, match.start) });
    parts.push({
      type: "element",
      tagName: "span",
      // Copy and citations read the emoticon as it was written.
      properties: {
        dataMarkdownEmoticon: "",
        dataMarkdownCopy: text.slice(match.start, match.end),
      },
      children: [{ type: "text", value: match.emoji }],
    });
    last = match.end;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

function visit(node: HastNode): void {
  const children = node.children;
  if (!children) return;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    if (child.type === "element") {
      if (!VERBATIM_TAGS.has(child.tagName ?? "")) visit(child);
    } else if (child.type === "text" && child.value) {
      const parts = emoticonParts(child.value);
      if (parts) children.splice(index, 1, ...parts);
    }
  }
}

/** Shows classic emoticons in message prose as emoji, leaving code and links verbatim. */
export function rehypeEmoticons() {
  return (tree: HastNode) => visit(tree);
}
