import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createThreadTailAtoms } from "@t3tools/client-runtime/state/thread-tail";
import type { OrchestrationV2ThreadTailMessage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { threadTailRefreshKey } from "../components/experts/ExpertsFeed.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadShells } from "./threads";

// One burst of shell updates, such as a run ending and its thread settling, makes one request.
const TAIL_REFRESH_DEBOUNCE_MS = 1_000;

const tailRefreshKeyAtom = Atom.family((key: string) => {
  const ref = parseScopedThreadKey(key)!;
  return Atom.make((get) =>
    threadTailRefreshKey(get(environmentThreadShells.threadShellAtom(ref))),
  ).pipe(Atom.debounce(TAIL_REFRESH_DEBOUNCE_MS), Atom.withLabel(`thread-tail-refresh:${key}`));
});

const threadTailAtom = createThreadTailAtoms(connectionAtomRuntime, {
  refreshTrigger: ({ environmentId, input }) =>
    tailRefreshKeyAtom(scopedThreadKey(scopeThreadRef(environmentId, input.threadId))),
});

export type ExpertTail =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | {
      readonly status: "ready";
      readonly messages: ReadonlyArray<OrchestrationV2ThreadTailMessage>;
    };

const LOADING: ExpertTail = { status: "loading" };
const FAILED: ExpertTail = { status: "failed" };

// Keyed by the experts' keys joined, so a changed set of experts reads a new list while each
// expert's own tail atom, and its data, stays.
const expertTailsAtom = Atom.family((keys: string) =>
  Atom.make((get): ReadonlyArray<ExpertTail> =>
    (keys === "" ? [] : keys.split("\n")).map((key) => {
      const ref = parseScopedThreadKey(key)!;
      const result = get(
        threadTailAtom({ environmentId: ref.environmentId, input: { threadId: ref.threadId } }),
      );
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) return { status: "ready", messages: value.messages };
      return AsyncResult.isFailure(result) ? FAILED : LOADING;
    }),
  ).pipe(Atom.withLabel("experts-feed-tails")),
);

/** The tail of each expert, in the order of `expertKeys`. */
export function useExpertTails(expertKeys: ReadonlyArray<string>): ReadonlyArray<ExpertTail> {
  return useAtomValue(expertTailsAtom(expertKeys.join("\n")));
}
