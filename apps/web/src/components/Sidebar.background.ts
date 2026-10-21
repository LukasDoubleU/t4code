import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useClientSettings } from "../hooks/useSettings";
import type { SidebarThreadSummary } from "../types";
import type { SidebarStatusGroup } from "./Sidebar.viewOptions";

/** Where a thread's menu or a drop sends it. */
export type SidebarBackgroundPlacement = "background" | "front";

const SidebarBackgroundChoice = Schema.Union([
  Schema.Struct({ placement: Schema.Literal("front") }),
  // The user's last message when the thread moved: a newer one brings it back.
  Schema.Struct({
    placement: Schema.Literal("background"),
    userMessageAt: Schema.NullOr(Schema.String),
  }),
]);
type SidebarBackgroundChoice = typeof SidebarBackgroundChoice.Type;

const SidebarBackgroundChoices = Schema.Record(Schema.String, SidebarBackgroundChoice);
/** This device's choices by thread key, kept only where they differ from the thread's origin. */
export type SidebarBackgroundChoices = typeof SidebarBackgroundChoices.Type;

type SidebarBackgroundThread = Pick<
  SidebarThreadSummary,
  "environmentId" | "id" | "latestUserMessageAt" | "latestUserAuthoredMessageAt"
> & { readonly source: Pick<SidebarThreadSummary["source"], "createdBy"> };

type SidebarBackgroundListing = SidebarBackgroundThread &
  Pick<SidebarThreadSummary, "settledOverride">;

const BACKGROUND_CHOICES_KEY = "t3code:sidebar:background-choices";
const NO_CHOICES: SidebarBackgroundChoices = {};

function threadKeyOf(thread: SidebarBackgroundThread): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function lastUserMessageAt(thread: SidebarBackgroundThread): string | null {
  // Older servers do not tell the user's messages from an agent's, so any message in the
  // user's role counts there.
  return thread.latestUserAuthoredMessageAt === undefined
    ? thread.latestUserMessageAt
    : thread.latestUserAuthoredMessageAt;
}

function choiceFor(
  choices: SidebarBackgroundChoices,
  thread: SidebarBackgroundThread,
): SidebarBackgroundChoice | undefined {
  return choices[threadKeyOf(thread)];
}

/**
 * Where a thread belongs before anything brings it forward. Background holds a thread an
 * agent started until the user writes in it, and a thread moved there by hand until the user
 * writes again. Bring to front keeps a thread in the main list for good.
 */
export function isSidebarBackgroundThread(
  thread: SidebarBackgroundThread,
  choice: SidebarBackgroundChoice | undefined,
): boolean {
  if (choice?.placement === "front") return false;
  const userMessageAt = lastUserMessageAt(thread);
  if (choice?.placement === "background") return userMessageAt === choice.userMessageAt;
  return thread.source.createdBy === "agent" && userMessageAt === null;
}

/**
 * Whether the sidebar lists a thread under Background. A thread there returns to the main
 * list while it needs the user, in the two statuses the Status sort puts first. `choices` is
 * null while the section is off.
 */
export function isInSidebarBackground<T extends SidebarBackgroundListing>(
  thread: T,
  choices: SidebarBackgroundChoices | null,
  statusGroupOf: (thread: T) => SidebarStatusGroup,
): boolean {
  // Settling wins. Checking it first also spares the many settled agent threads the
  // status check on every sidebar update.
  if (choices === null || thread.settledOverride === "settled") return false;
  if (!isSidebarBackgroundThread(thread, choiceFor(choices, thread))) return false;
  const statusGroup = statusGroupOf(thread);
  return statusGroup !== "needs_you" && statusGroup !== "failed";
}

/**
 * The placement a thread's menu offers: the side Background does not put it on. Pinned,
 * snoozed and settled threads keep their own sections, so their menu offers neither.
 */
export function sidebarBackgroundMenuPlacement(input: {
  readonly thread: SidebarBackgroundThread;
  readonly choices: SidebarBackgroundChoices | null;
  readonly parked: boolean;
}): SidebarBackgroundPlacement | null {
  if (input.choices === null || input.parked) return null;
  return isSidebarBackgroundThread(input.thread, choiceFor(input.choices, input.thread))
    ? "front"
    : "background";
}

/** The choices after moving `threads` to `placement`. */
export function placeSidebarThreads(
  choices: SidebarBackgroundChoices,
  threads: ReadonlyArray<SidebarBackgroundThread>,
  placement: SidebarBackgroundPlacement,
): SidebarBackgroundChoices {
  const moved = new Set(threads.map(threadKeyOf));
  const next: Record<string, SidebarBackgroundChoice> = Object.fromEntries(
    Object.entries(choices).filter(([key]) => !moved.has(key)),
  );
  for (const thread of threads) {
    // A thread whose origin already puts it there needs no choice.
    if (isSidebarBackgroundThread(thread, undefined) === (placement === "background")) continue;
    next[threadKeyOf(thread)] =
      placement === "front"
        ? { placement: "front" }
        : { placement: "background", userMessageAt: lastUserMessageAt(thread) };
  }
  return next;
}

/**
 * The section's switch and this device's choices; `choices` is null while the switch is off.
 * Like the sidebar's other view choices, each device keeps its own.
 */
export function useSidebarBackground() {
  const enabled = useClientSettings((settings) => settings.sidebarBackgroundSection);
  const [choices, setChoices] = useLocalStorage(
    BACKGROUND_CHOICES_KEY,
    NO_CHOICES,
    SidebarBackgroundChoices,
  );
  return {
    choices: enabled ? choices : null,
    place: (
      threads: ReadonlyArray<SidebarBackgroundThread>,
      placement: SidebarBackgroundPlacement,
    ) => setChoices((current) => placeSidebarThreads(current, threads, placement)),
  };
}
