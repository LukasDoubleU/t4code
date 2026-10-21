import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "./baseSchemas.ts";
import { threadMemoryFileName, threadMemoryFilePath } from "./threadMemory.ts";

describe("threadMemoryFileName", () => {
  it("keeps only characters every file system accepts", () => {
    expect(threadMemoryFileName(ThreadId.make("command:abc:fork"))).toBe("command_abc_fork.md");
    expect(threadMemoryFileName(ThreadId.make("a/b\\c*d"))).toBe("a_b_c_d.md");
    expect(threadMemoryFileName(ThreadId.make("6f1c-2b.x_y"))).toBe("6f1c-2b.x_y.md");
  });
});

describe("threadMemoryFilePath", () => {
  const threadId = ThreadId.make("thread:1");

  it("joins with the separator the server's directory uses", () => {
    expect(threadMemoryFilePath("C:\\Users\\me\\.t3\\userdata\\memory", threadId)).toBe(
      "C:\\Users\\me\\.t3\\userdata\\memory\\thread_1.md",
    );
    expect(threadMemoryFilePath("/home/me/.t3/userdata/memory", threadId)).toBe(
      "/home/me/.t3/userdata/memory/thread_1.md",
    );
  });

  it("does not double a trailing separator", () => {
    expect(threadMemoryFilePath("/srv/memory/", threadId)).toBe("/srv/memory/thread_1.md");
  });
});
