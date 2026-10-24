import { describe, expect, it } from "vite-plus/test";
import { markdownWithEmoticons } from "./markdownDocument";

describe("emoticons in chat markdown", () => {
  it("become emoji in prose, emphasis, lists and quotes", () => {
    expect(markdownWithEmoticons("Works :D\n\n- *nice :)*\n\n> <3")).toBe(
      "Works 😄\n\n- *nice 🙂*\n\n> ❤️",
    );
  });

  it("stay verbatim in inline code, fenced code and links", () => {
    const markdown = [
      "Run `:D` and ` :) `.",
      "",
      "```",
      "x = 1 :)",
      "```",
      "",
      "~~~",
      ":D",
      "~~~",
      "",
      "    indented :D",
      "",
      "[see :D](https://example.com) <https://example.com/:D> https://example.com/(:D)",
    ].join("\n");
    expect(markdownWithEmoticons(markdown)).toBe(markdown);
  });

  it("leave paths and words that contain a token alone", () => {
    const markdown = "Open C:\\D or std::D, see src/:D and yes:D";
    expect(markdownWithEmoticons(markdown)).toBe(markdown);
  });
});
