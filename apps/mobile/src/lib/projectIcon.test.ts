import { describe, expect, it } from "vite-plus/test";

import { emojiIconInput, threadIconSource } from "./projectIcon";

describe("threadIconSource", () => {
  const project = { title: "Docs", projectIcon: { kind: "emoji", emoji: "x" } as const };

  it("shows the project's icon until the thread has one of its own", () => {
    expect(threadIconSource(project, { title: "Release", icon: null })).toEqual({
      projectIcon: project.projectIcon,
      projectTitle: "Docs",
    });
    const own = { kind: "lucide", name: "flask-conical", color: "teal" } as const;
    expect(threadIconSource(project, { title: "Release", icon: own })).toEqual({
      projectIcon: own,
      projectTitle: "Release",
    });
  });
});

describe("emojiIconInput", () => {
  it("takes an emoji and refuses text", () => {
    expect(emojiIconInput("  \u{1F9EA} ")).toBe("\u{1F9EA}");
    expect(emojiIconInput("\u{1F468}‍\u{1F469}‍\u{1F467}")).toBe("\u{1F468}‍\u{1F469}‍\u{1F467}");
    expect(emojiIconInput("")).toBeNull();
    expect(emojiIconInput("Docs")).toBeNull();
  });
});
