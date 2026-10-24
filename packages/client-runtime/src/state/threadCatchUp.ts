import type { OrchestrationV2Actor, OrchestrationV2ThreadCatchUp } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

/**
 * The thread state a brief was written from: its items and what waits on the user. A brief whose
 * basis no longer matches the thread's is stale.
 */
export function threadCatchUpBasis(thread: {
  readonly itemCount: number;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly attention?: { readonly requestedAt: string } | null | undefined;
}): string {
  return [
    thread.itemCount,
    thread.hasPendingApprovals ? "approval" : "",
    thread.hasPendingUserInput ? "question" : "",
    thread.attention?.requestedAt ?? "",
  ].join("|");
}

export interface ThreadCatchUpState {
  readonly open: boolean;
  readonly loading: boolean;
  readonly brief: OrchestrationV2ThreadCatchUp | null;
  /** The basis `brief` was written from. */
  readonly basis: string | null;
  readonly error: string | null;
}

const CLOSED: ThreadCatchUpState = {
  open: false,
  loading: false,
  brief: null,
  basis: null,
  error: null,
};

/** One cached brief per thread key, kept while the user moves between threads. */
export const threadCatchUpAtom = Atom.family((threadKey: string) =>
  Atom.make<ThreadCatchUpState>(CLOSED).pipe(
    Atom.keepAlive,
    Atom.withLabel(`thread-catch-up:${threadKey}`),
  ),
);

export function isThreadCatchUpStale(state: ThreadCatchUpState, basis: string): boolean {
  return state.brief !== null && state.basis !== basis;
}

export type ThreadCatchUpGeneration =
  | { readonly ok: true; readonly brief: OrchestrationV2ThreadCatchUp }
  | { readonly ok: false; readonly message: string };

/**
 * Opens the card. A fresh cached brief is shown again as it is; a missing or stale one is
 * written anew. Never called on its own: only a click asks for a brief.
 */
export async function requestThreadCatchUp(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadKey: string;
  readonly basis: string;
  readonly generate: () => Promise<ThreadCatchUpGeneration>;
}): Promise<void> {
  const atom = threadCatchUpAtom(input.threadKey);
  const current = input.registry.get(atom);
  if (current.loading) {
    input.registry.set(atom, { ...current, open: true });
    return;
  }
  if (current.brief !== null && current.basis === input.basis) {
    input.registry.set(atom, { ...current, open: true, error: null });
    return;
  }
  input.registry.set(atom, { ...current, open: true, loading: true, error: null });
  const result = await input.generate();
  const latest = input.registry.get(atom);
  input.registry.set(
    atom,
    result.ok
      ? { ...latest, loading: false, brief: result.brief, basis: input.basis, error: null }
      : { ...latest, loading: false, error: result.message },
  );
}

export function closeThreadCatchUp(registry: AtomRegistry.AtomRegistry, threadKey: string): void {
  const atom = threadCatchUpAtom(threadKey);
  registry.set(atom, { ...registry.get(atom), open: false, error: null });
}

/** Mirrors the server's `latestUserAuthoredMessageAt`: wakes and other agents' messages also use the user role. */
export function isUserAuthoredMessage(message: {
  readonly role: string;
  readonly createdBy?: OrchestrationV2Actor | undefined;
}): boolean {
  // Messages still waiting for the server's echo carry no author and are the user's own.
  return message.role === "user" && (message.createdBy ?? "user") === "user";
}

/**
 * Where the "Since your last visit" divider goes: before the first item newer than the visit.
 * -1 when nothing is newer or the thread was never visited.
 */
export function sinceLastVisitIndex(
  items: ReadonlyArray<{ readonly createdAt: string | null }>,
  lastVisitedAt: string | null | undefined,
): number {
  if (lastVisitedAt == null) return -1;
  const visitedAt = Date.parse(lastVisitedAt);
  if (Number.isNaN(visitedAt)) return -1;
  return items.findIndex(
    (item) => item.createdAt !== null && Date.parse(item.createdAt) > visitedAt,
  );
}

export interface SinceLastVisitMarker {
  readonly threadKey: string | null;
  /** The visit taken when the thread opened; undefined until its shell is known. */
  readonly visitedAt: string | null | undefined;
  /** The divider's visit once the thread's items loaded: null for no divider. */
  readonly at: string | null | undefined;
}

export const EMPTY_SINCE_LAST_VISIT_MARKER: SinceLastVisitMarker = {
  threadKey: null,
  visitedAt: undefined,
  at: undefined,
};

/**
 * The visit the divider marks is taken when the thread opens: opening it records a new visit
 * right away, and the divider must not follow it. Without anything newer at open there is no
 * divider, so the user's own messages sent while reading never get one. Returns `marker` itself
 * when nothing changed.
 */
export function nextSinceLastVisitMarker(
  marker: SinceLastVisitMarker,
  input: {
    readonly threadKey: string | null;
    readonly lastVisitedAt: string | null | undefined;
    readonly items: ReadonlyArray<{ readonly createdAt: string | null }>;
    readonly itemsReady: boolean;
  },
): SinceLastVisitMarker {
  let next = marker;
  if (next.threadKey !== input.threadKey) {
    next = { threadKey: input.threadKey, visitedAt: input.lastVisitedAt, at: undefined };
  } else if (next.visitedAt === undefined && input.lastVisitedAt !== undefined) {
    next = { ...next, visitedAt: input.lastVisitedAt };
  }
  if (next.at === undefined && next.visitedAt !== undefined && input.itemsReady) {
    next = {
      ...next,
      at: sinceLastVisitIndex(input.items, next.visitedAt) >= 0 ? next.visitedAt : null,
    };
  }
  return next;
}
