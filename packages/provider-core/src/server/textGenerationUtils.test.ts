import { describe, expect, it } from "vite-plus/test";

import { sanitizeCommitSubject, sanitizeThreadCatchUp } from "./textGenerationUtils.ts";

describe("sanitizeCommitSubject", () => {
  // regression: #19181 truncation split grapheme clusters at the subject limit
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });
});

describe("sanitizeThreadCatchUp", () => {
  it("keeps three plain lines and reads an empty needsYou as nothing", () => {
    expect(
      sanitizeThreadCatchUp({
        needsYou: "  ",
        happened: ["- Fixed the build", "", "2. Opened #12", "* Ran the tests", "• Fourth"],
        next: "  Waits for review\n",
      }),
    ).toEqual({
      needsYou: null,
      happened: ["Fixed the build", "Opened #12", "Ran the tests"],
      next: "Waits for review",
    });
  });
});
