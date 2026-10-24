import { describe, expect, it } from "vite-plus/test";

import { rehypeEmoticons } from "./markdownEmoticons";

const text = (value: string) => ({ type: "text", value });
const element = (tagName: string, children: object[]) => ({
  type: "element",
  tagName,
  properties: {} as Record<string, unknown>,
  children,
});

function withEmoticons(...children: ReturnType<typeof element>[]) {
  const tree = { type: "root", children };
  rehypeEmoticons()(tree);
  return tree.children;
}

describe("rehypeEmoticons", () => {
  it("shows an emoticon as emoji and keeps the original for copy", () => {
    const [paragraph] = withEmoticons(element("p", [text("Works :D, thanks")]));
    expect(paragraph!.children).toEqual([
      text("Works "),
      {
        type: "element",
        tagName: "span",
        properties: { dataMarkdownEmoticon: "", dataMarkdownCopy: ":D" },
        children: [text("😄")],
      },
      text(", thanks"),
    ]);
  });

  it("converts emphasized and nested prose", () => {
    const [list] = withEmoticons(element("ul", [element("li", [element("em", [text(":)")])])]));
    expect(JSON.stringify(list)).toContain("🙂");
  });

  it("leaves inline code, code blocks and links verbatim", () => {
    const code = element("code", [text(":D")]);
    const pre = element("pre", [element("code", [text("x = 1 :)")])]);
    const link = element("a", [text("see :D")]);
    withEmoticons(element("p", [code, link]), pre);
    expect(code.children).toEqual([text(":D")]);
    expect(link.children).toEqual([text("see :D")]);
    expect(JSON.stringify(pre)).not.toContain("🙂");
  });
});
