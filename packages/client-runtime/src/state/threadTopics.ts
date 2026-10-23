import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";

import { threadKey } from "./entities.ts";

/** What a thread says about the thread it came from. */
export type ThreadTopicLinks = Pick<
  OrchestrationV2ThreadShell,
  "launchedBy" | "delegatedFrom" | "continuedIn" | "lineage"
>;

// The thread whose work this one is: the thread it continues in after a fresh start, the
// parent of a subagent or delegated task, or the thread whose agent launched it.
function upstreamOf(environmentId: ScopedThreadRef["environmentId"], thread: ThreadTopicLinks) {
  if (thread.continuedIn !== undefined) return { environmentId, threadId: thread.continuedIn };
  const { parentThreadId, relationshipToParent } = thread.lineage;
  if (relationshipToParent === "subagent" && parentThreadId !== null) {
    return { environmentId, threadId: parentThreadId };
  }
  return thread.delegatedFrom ?? thread.launchedBy ?? null;
}

/**
 * The expert a launched thread is a topic of: the nearest expert up from its launcher, through
 * subagents and delegated tasks, the expert's other topics, and threads that started fresh in
 * it. Topics stay flat, so a helper's launch belongs to the expert behind it. The walk ends,
 * without an expert, at a loop, a thread this client does not know, or a thread on another
 * environment that is not itself an expert.
 */
export function resolveThreadTopicOf(input: {
  readonly ref: ScopedThreadRef;
  readonly thread: Pick<ThreadTopicLinks, "launchedBy">;
  readonly lookup: (ref: ScopedThreadRef) => ThreadTopicLinks | undefined;
  readonly isExpert: (ref: ScopedThreadRef) => boolean;
}): ScopedThreadRef | null {
  const { lookup, isExpert } = input;
  const seen = new Set([threadKey(input.ref)]);
  let current: ScopedThreadRef | null = input.thread.launchedBy ?? null;
  while (current !== null) {
    const key = threadKey(current);
    if (seen.has(key)) return null;
    if (isExpert(current)) return current;
    if (current.environmentId !== input.ref.environmentId) return null;
    seen.add(key);
    const thread = lookup(current);
    if (thread === undefined) return null;
    current = upstreamOf(current.environmentId, thread);
  }
  return null;
}
