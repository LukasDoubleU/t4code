import {
  type OrchestrationV2TurnItem,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  catchUpItemsText,
  catchUpRunIds,
  catchUpStart,
  catchUpWaitingOnUser,
} from "./threadCatchUpInput.ts";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 12, minute));

function message(
  minute: number,
  role: "user" | "assistant",
  text: string,
  extra: {
    readonly createdBy?: "user" | "agent" | "system";
    readonly senderThreadId?: string;
  } = {},
) {
  return {
    role,
    text,
    attachments: [],
    streaming: false,
    createdAt: at(minute),
    createdBy: extra.createdBy ?? (role === "user" ? ("user" as const) : ("agent" as const)),
    creationSource: extra.senderThreadId === undefined ? ("web" as const) : ("mcp" as const),
    ...(extra.senderThreadId === undefined
      ? {}
      : { senderThreadId: ThreadId.make(extra.senderThreadId) }),
  };
}

// Fixtures fill only the fields of their own item type.
function item(
  minute: number,
  fields: { readonly type: OrchestrationV2TurnItem["type"] } & Record<string, unknown>,
): OrchestrationV2TurnItem {
  return {
    ...baseItemFields,
    id: TurnItemId.make(`item-${minute}-${fields.type}`),
    startedAt: at(minute),
    updatedAt: at(minute),
    ...fields,
  } as OrchestrationV2TurnItem;
}

const baseItemFields = {
  threadId: ThreadId.make("thread-1"),
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "pending",
  title: null,
  completedAt: null,
} as const;

describe("catchUpStart", () => {
  it("starts at the user's latest message or last visit, whichever is earlier", () => {
    const messages = [
      message(1, "user", "first ask"),
      message(5, "user", "latest ask"),
      // Another thread's message uses the user role, but the user did not write it.
      message(9, "user", "report", { createdBy: "agent", senderThreadId: "thread-2" }),
    ];
    expect(catchUpStart({ messages, lastVisitedAt: at(7) })).toEqual(at(5));
    expect(catchUpStart({ messages, lastVisitedAt: at(3) })).toEqual(at(3));
  });

  it("reads the whole thread without a visit or a message from the user", () => {
    expect(catchUpStart({ messages: [message(1, "user", "ask")], lastVisitedAt: null })).toBe(null);
    expect(catchUpStart({ messages: [message(1, "assistant", "hi")], lastVisitedAt: at(4) })).toBe(
      null,
    );
  });
});

describe("catchUpRunIds", () => {
  it("keeps runs started since the start and runs still going", () => {
    const runs = [
      { id: RunId.make("old"), status: "completed" as const, requestedAt: at(1) },
      { id: RunId.make("steered"), status: "running" as const, requestedAt: at(2) },
      { id: RunId.make("new"), status: "completed" as const, requestedAt: at(6) },
    ];
    expect(catchUpRunIds(runs, at(5))).toEqual(["steered", "new"]);
  });
});

describe("catchUpItemsText", () => {
  it("labels who said what since the start and lists changed files once", () => {
    const text = catchUpItemsText({
      start: at(5),
      messages: [
        message(1, "user", "an old ask"),
        message(5, "user", "Fix the login bug"),
        message(6, "user", "Done on my side", { createdBy: "agent", senderThreadId: "thread-2" }),
        message(8, "assistant", "Fixed it. Should I also update the docs?"),
      ],
      turnItems: [
        item(6, {
          type: "file_change",
          fileName: "src/login.ts",
        }),
        item(7, {
          type: "file_change",
          fileName: "src/login.ts",
        }),
        item(7, {
          type: "error",
          failure: {
            class: "provider_error",
            message: "Rate limited",
            code: null,
            retryable: true,
          },
        }),
      ],
    });
    expect(text).toBe(
      [
        "You: Fix the login bug",
        "Message from another thread: Done on my side",
        "Error: Rate limited",
        "Agent: Fixed it. Should I also update the docs?",
        "Files the agent changed: src/login.ts",
      ].join("\n"),
    );
  });

  it("caps a busy thread, condensing older items and keeping the user's ask", () => {
    const long = (label: string) => `${label} ${"word ".repeat(2_000)}end of ${label}`;
    const messages = [
      message(0, "user", "The original ask"),
      ...Array.from({ length: 50 }, (_, index) =>
        message(index + 1, "assistant", long(`reply ${index + 1}`)),
      ),
    ];
    const text = catchUpItemsText({ start: at(0), messages, turnItems: [] });
    const lines = text.split("\n");

    expect(text.length).toBeLessThan(25_000);
    expect(lines[0]).toBe("You: The original ask");
    expect(lines[1]).toMatch(/^\[\d+ more items left out\]$/);
    // The newest reply keeps its detail, start and end.
    expect(lines.at(-1)).toMatch(/^Agent: reply 50 word/);
    expect(lines.at(-1)).toMatch(/end of reply 50$/);
    expect(lines.at(-1)!.length).toBeGreaterThan(3_000);
    // Older replies past the detail budget shrink to a line.
    expect(lines[2]!.length).toBeLessThanOrEqual(400);
  });
});

describe("catchUpWaitingOnUser", () => {
  it("names open approvals, questions and a call for the user, not answered ones", () => {
    const facts = catchUpWaitingOnUser({
      attention: { reason: "Pick a release date" },
      runtimeRequests: [
        { id: RuntimeRequestId.make("approval-open"), status: "pending" },
        { id: RuntimeRequestId.make("question-open"), status: "pending" },
        { id: RuntimeRequestId.make("approval-done"), status: "resolved" },
      ],
      turnItems: [
        item(1, {
          type: "approval_request",
          requestId: RuntimeRequestId.make("approval-open"),
          requestKind: "command",
          prompt: "Run pnpm publish",
        }),
        item(2, {
          type: "user_input_request",
          requestId: RuntimeRequestId.make("question-open"),
          questions: [
            {
              id: "q1",
              header: "Target",
              question: "Which branch should I use?",
              options: [],
            },
          ],
        }),
        item(3, {
          type: "approval_request",
          requestId: RuntimeRequestId.make("approval-done"),
          requestKind: "command",
          prompt: "Run rm -rf build",
        }),
      ],
    });
    expect(facts).toEqual([
      "The agent waits for your approval: Run pnpm publish",
      "The agent asks you: Which branch should I use?",
      "The agent asked for you: Pick a release date",
    ]);
  });
});
