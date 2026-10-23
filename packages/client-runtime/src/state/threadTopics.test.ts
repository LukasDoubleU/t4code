import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { threadKey } from "./entities.ts";
import { resolveThreadTopicOf, type ThreadTopicLinks } from "./threadTopics.ts";

const local = EnvironmentId.make("environment-local");
const remote = EnvironmentId.make("environment-remote");
const ref = (id: string, environmentId = local): ScopedThreadRef => ({
  environmentId,
  threadId: ThreadId.make(id),
});
const by = (id: string, environmentId = local) => ({ ...ref(id, environmentId), title: id });
const thread = (links: Partial<ThreadTopicLinks> = {}): ThreadTopicLinks => ({
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("x") },
  ...links,
});
const subagentOf = (parent: string) =>
  thread({
    lineage: {
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
      rootThreadId: ThreadId.make(parent),
    },
  });

/** Resolves the topic of a thread launched by `launcher`, among `threads` on this machine. */
function topicOf(
  launcher: ReturnType<typeof by> | undefined,
  threads: Record<string, ThreadTopicLinks>,
  experts: readonly ScopedThreadRef[] = [ref("expert")],
): string | null {
  const known = new Map(
    Object.entries(threads).map(([id, links]) => [threadKey(ref(id)), links] as const),
  );
  const expertKeys = new Set(experts.map(threadKey));
  const expert = resolveThreadTopicOf({
    ref: ref("topic"),
    thread: launcher === undefined ? {} : { launchedBy: launcher },
    lookup: (target) => known.get(threadKey(target)),
    isExpert: (target) => expertKeys.has(threadKey(target)),
  });
  return expert === null ? null : threadKey(expert);
}

describe("resolveThreadTopicOf", () => {
  it("makes a thread an expert launched its topic, on any machine", () => {
    expect(topicOf(by("expert"), {})).toBe(threadKey(ref("expert")));
    expect(topicOf(by("expert", remote), {}, [ref("expert", remote)])).toBe(
      threadKey(ref("expert", remote)),
    );
  });

  it("leaves a thread nobody or no expert launched alone", () => {
    expect(topicOf(undefined, {})).toBeNull();
    expect(topicOf(by("coordinator"), { coordinator: thread() })).toBeNull();
  });

  it("gives a thread an expert's subagent launched to the expert", () => {
    expect(topicOf(by("helper"), { helper: subagentOf("expert") })).toBe(threadKey(ref("expert")));
  });

  it("gives a thread a task delegated from another machine launched to its expert", () => {
    const experts = [ref("expert", remote)];
    const task = thread({ delegatedFrom: by("expert", remote) });
    expect(topicOf(by("task"), { task }, experts)).toBe(threadKey(ref("expert", remote)));
  });

  it("keeps a topic's own launches flat under the expert", () => {
    expect(
      topicOf(by("second"), {
        second: thread({ launchedBy: by("first") }),
        first: thread({ launchedBy: by("helper") }),
        helper: subagentOf("expert"),
      }),
    ).toBe(threadKey(ref("expert")));
  });

  it("follows an expert that started fresh to the thread it continues in", () => {
    expect(
      topicOf(by("old"), {
        old: thread({ continuedIn: ThreadId.make("middle"), launchedBy: by("someone") }),
        middle: thread({ continuedIn: ThreadId.make("expert") }),
      }),
    ).toBe(threadKey(ref("expert")));
  });

  it("ends at a loop instead of spinning", () => {
    expect(
      topicOf(by("a"), {
        a: thread({ launchedBy: by("b") }),
        b: thread({ continuedIn: ThreadId.make("a") }),
      }),
    ).toBeNull();
    expect(topicOf(by("a"), { a: thread({ launchedBy: by("topic") }) })).toBeNull();
    // Even a pinned thread is never its own topic.
    expect(topicOf(by("a"), { a: thread({ launchedBy: by("topic") }) }, [ref("topic")])).toBeNull();
  });

  it("ends at a thread this client does not know", () => {
    expect(topicOf(by("gone"), {})).toBeNull();
    expect(topicOf(by("helper"), { helper: subagentOf("gone") })).toBeNull();
  });

  it("does not walk through threads on another machine", () => {
    const experts = [ref("expert")];
    const elsewhere = thread({ launchedBy: by("expert") });
    const known = new Map([[threadKey(ref("coordinator", remote)), elsewhere]]);
    expect(
      resolveThreadTopicOf({
        ref: ref("topic"),
        thread: { launchedBy: by("coordinator", remote) },
        lookup: (target) => known.get(threadKey(target)),
        isExpert: (target) => experts.some((expert) => threadKey(expert) === threadKey(target)),
      }),
    ).toBeNull();
  });
});
