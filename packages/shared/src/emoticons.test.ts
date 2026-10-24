import { describe, expect, it } from "vite-plus/test";

import { findEmoticons, replaceEmoticons } from "./emoticons.ts";

describe("replaceEmoticons", () => {
  it("shows every emoticon in the table as its emoji", () => {
    expect(replaceEmoticons(":) :-) :D :-D ;) ;-) :( :-( :P :p :O :o xD XD <3")).toBe(
      "🙂 🙂 😄 😄 😉 😉 🙁 🙁 😛 😛 😮 😮 😆 😆 ❤️",
    );
  });

  it("takes a token at the start, after whitespace or after opening punctuation", () => {
    expect(replaceEmoticons(":D thanks")).toBe("😄 thanks");
    expect(replaceEmoticons("thanks\n:D")).toBe("thanks\n😄");
    expect(replaceEmoticons("(:D)")).toBe("(😄)");
    expect(replaceEmoticons('"<3"')).toBe('"❤️"');
    expect(replaceEmoticons("*:D*")).toBe("*😄*");
  });

  it("takes a token before the end, whitespace or closing punctuation", () => {
    expect(replaceEmoticons("works :D.")).toBe("works 😄.");
    expect(replaceEmoticons("works :D, thanks")).toBe("works 😄, thanks");
    expect(replaceEmoticons("(nice :))")).toBe("(nice 🙂)");
    expect(replaceEmoticons("done :D!!")).toBe("done 😄!!");
  });

  it("leaves tokens inside a word alone", () => {
    expect(replaceEmoticons("std::D")).toBe("std::D");
    expect(replaceEmoticons("yes:D")).toBe("yes:D");
    expect(replaceEmoticons("foo(:D)")).toBe("foo(:D)");
    expect(replaceEmoticons(":Done")).toBe(":Done");
    expect(replaceEmoticons("xDebug 0xD <30 <3.5")).toBe("xDebug 0xD <30 <3.5");
    expect(replaceEmoticons("foo();)")).toBe("foo();)");
  });

  it("leaves paths and URLs alone", () => {
    expect(replaceEmoticons("C:\\D")).toBe("C:\\D");
    expect(replaceEmoticons("C:\\Data\\:D")).toBe("C:\\Data\\:D");
    expect(replaceEmoticons("see src/:D/x and ./:)")).toBe("see src/:D/x and ./:)");
    expect(replaceEmoticons("https://example.com/(:D) http://host:o")).toBe(
      "https://example.com/(:D) http://host:o",
    );
  });

  it("skips backtick code spans and fences but not unmatched backticks", () => {
    expect(replaceEmoticons("run `:D` now :D")).toBe("run `:D` now 😄");
    expect(replaceEmoticons("`` a ` :) `` :)")).toBe("`` a ` :) `` 🙂");
    expect(replaceEmoticons("```\n:D\n```\n:D")).toBe("```\n:D\n```\n😄");
    expect(replaceEmoticons("a ` b :D")).toBe("a ` b 😄");
  });

  it("returns the same string when nothing changes", () => {
    const text = "plain text";
    expect(replaceEmoticons(text)).toBe(text);
    expect(findEmoticons("std::D")).toEqual([]);
  });
});

describe("findEmoticons", () => {
  it("reports where each emoticon is in the original text", () => {
    expect(findEmoticons("hi :-) <3")).toEqual([
      { start: 3, end: 6, emoji: "🙂" },
      { start: 7, end: 9, emoji: "❤️" },
    ]);
  });
});
