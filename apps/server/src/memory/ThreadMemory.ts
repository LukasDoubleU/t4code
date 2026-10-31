import {
  isUserPinnedThread,
  threadMemoryFileName,
  threadMemoryFilePath,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

/** Versions of one thread's memory file kept in its backup folder. */
export const MEMORY_BACKUPS_KEPT = 20;
const BACKUP_NAME = /^\d{6}-.+\.md$/;

/** The share of the context window at which a pinned thread is told to save its memory. */
const MEMORY_NUDGE_CONTEXT_SHARE = 0.85;

/**
 * The same text on every turn of a thread, so the provider's prompt cache
 * stays valid until the thread is pinned, unpinned, gets its own icon or the
 * setting changes.
 */
export function threadMemoryInstructions(
  path: string,
  { continuedFrom, icon }: Pick<OrchestrationV2AppThread, "continuedFrom" | "icon"> = {},
): string {
  return [
    `This thread keeps a memory file: ${path}`,
    ...(continuedFrom === undefined
      ? []
      : [
          `It continues thread ${continuedFrom} and took over that thread's memory: read the file before anything else and carry on in the role it describes.`,
        ]),
    "Read it at the start of a session and again after every compaction.",
    "Keep it current: the thread's purpose, the current state, decisions and their reasons, the user's preferences, and open points.",
    "Not the history, which stays in the thread. Keep it under about 8k tokens and never put secrets in it.",
    "Create it the first time there is something worth keeping.",
    // Only while unset, so an agent never replaces the user's choice.
    ...(icon == null
      ? [
          "This thread has no icon of its own yet: set one that fits its role, once, with t3_thread_update (action set_icon), an emoji or a Lucide icon name, distinct from the other pinned threads where possible.",
        ]
      : []),
  ].join(" ");
}

/** For a fork whose copied history points at its source thread's memory file. */
export function threadMemoryForkNote(sourcePath: string): string {
  return [
    `This thread was forked from another thread. The memory file named earlier in this conversation, ${sourcePath}, belongs to that thread, not to this one.`,
    "Don't create, update or overwrite it. Reading it for context is fine.",
  ].join(" ");
}

/** For the first turn after the context came close to its limit. */
export function threadMemoryNudge(path: string): string {
  return [
    "This conversation is close to its context limit and will be compacted soon.",
    `Before you continue, update the memory file ${path} with anything worth keeping that it does not hold yet.`,
  ].join(" ");
}

function contextNearlyFull(usage: OrchestrationV2ProviderTurnTokenUsage): boolean {
  const limit = Math.min(
    usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : Infinity,
    usage.autoCompactThreshold ?? Infinity,
  );
  return Number.isFinite(limit) && usage.usedTokens >= limit * MEMORY_NUDGE_CONTEXT_SHARE;
}

/**
 * Whether the next turn should be told to save its memory: the newest usage report is near the
 * limit and the newest from an earlier attempt was not, so it comes once per approach and again
 * only after a compaction. Providers that report no window never get it.
 */
export function memoryNudgeDue(
  providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "id" | "providerThreadId" | "runAttemptId" | "tokenUsage">
  >,
  providerThreadId: ProviderThreadId,
): boolean {
  const reports = providerTurns
    .flatMap((turn) =>
      turn.providerThreadId === providerThreadId && turn.tokenUsage !== undefined
        ? [{ attempt: turn.runAttemptId ?? turn.id, usage: turn.tokenUsage }]
        : [],
    )
    // Ties go to the later entry, since live upserts append.
    .toSorted(
      (left, right) => Date.parse(left.usage.updatedAt) - Date.parse(right.usage.updatedAt),
    );
  const latest = reports.at(-1);
  if (latest === undefined || !contextNearlyFull(latest.usage)) return false;
  const before = reports.findLast((report) => report.attempt !== latest.attempt);
  return before === undefined || !contextNearlyFull(before.usage);
}

/** What a turn's end found in a thread's memory file. */
export type MemoryTurnRecord = "changed" | "unchanged" | "missing";

export class ThreadMemory extends Context.Service<
  ThreadMemory,
  {
    readonly directory: string;
    /** The memory a turn of this thread carries, or undefined while it sleeps. */
    readonly forTurn: (
      thread: Pick<
        OrchestrationV2AppThread,
        "id" | "pinnedAt" | "lineage" | "continuedFrom" | "icon"
      >,
    ) => Effect.Effect<{ readonly path: string; readonly instructions: string } | undefined>;
    /**
     * The note for a native fork's first turn, or undefined when its source
     * never kept a memory its history could name.
     */
    readonly forkNote: (source: {
      readonly id: ThreadId;
      readonly pinned: boolean;
    }) => Effect.Effect<string | undefined>;
    /**
     * Moves a thread's memory file and its backups to another thread, so only
     * that thread writes them from now on.
     */
    readonly handOver: (from: ThreadId, to: ThreadId) => Effect.Effect<void, PlatformError>;
    /**
     * Keeps a copy of the memory file when it differs from the newest one
     * kept, and says whether it did.
     */
    readonly recordTurn: (threadId: ThreadId) => Effect.Effect<MemoryTurnRecord, PlatformError>;
  }
>()("t3/memory/ThreadMemory") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Below the state directory rather than the bare T3 home, so a dev server
  // sharing a home with an install still keeps its own memories.
  const directory = path.join(config.stateDir, "memory");
  const backupDirectory = (threadId: ThreadId) =>
    path.join(directory, "backups", threadMemoryFileName(threadId).replace(/\.md$/, ""));

  const forTurn = Effect.fn("ThreadMemory.forTurn")(function* (
    thread: Pick<
      OrchestrationV2AppThread,
      "id" | "pinnedAt" | "lineage" | "continuedFrom" | "icon"
    >,
  ) {
    if (!isUserPinnedThread(thread)) return undefined;
    const current = yield* settings.getSettings.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Thread memory could not read the server settings.", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (current === undefined || !current.pinnedThreadsKeepMemory) return undefined;
    // The agent writes the file; not every provider's write tool creates missing folders.
    yield* fileSystem
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Thread memory could not create its folder.", { cause }),
        ),
      );
    const memoryPath = threadMemoryFilePath(directory, thread.id);
    return {
      path: memoryPath,
      instructions: threadMemoryInstructions(memoryPath, thread),
    };
  });

  // Not gated on the setting: the source's history may name its file from
  // before the setting was turned off.
  const forkNote = Effect.fn("ThreadMemory.forkNote")(function* (source: {
    readonly id: ThreadId;
    readonly pinned: boolean;
  }) {
    const sourcePath = threadMemoryFilePath(directory, source.id);
    const kept =
      source.pinned ||
      (yield* fileSystem.exists(sourcePath).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Thread memory could not check a fork source's file.", {
            cause,
          }).pipe(Effect.as(true)),
        ),
      ));
    return kept ? threadMemoryForkNote(sourcePath) : undefined;
  });

  const handOver = Effect.fn("ThreadMemory.handOver")(function* (from: ThreadId, to: ThreadId) {
    const moves = [
      [threadMemoryFilePath(directory, from), threadMemoryFilePath(directory, to)],
      [backupDirectory(from), backupDirectory(to)],
    ] as const;
    for (const [source, target] of moves) {
      if (!(yield* fileSystem.exists(source))) continue;
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.rename(source, target);
    }
  });

  const recordTurn = Effect.fn("ThreadMemory.recordTurn")(function* (threadId: ThreadId) {
    const file = threadMemoryFilePath(directory, threadId);
    if (!(yield* fileSystem.exists(file))) return "missing" as const;
    const content = yield* fileSystem.readFileString(file);
    const backups = backupDirectory(threadId);
    yield* fileSystem.makeDirectory(backups, { recursive: true });
    // A sequence number leads the name, so versions sort oldest first even
    // when two land in the same millisecond; the time is for people.
    const kept = (yield* fileSystem.readDirectory(backups))
      .filter((name) => BACKUP_NAME.test(name))
      .toSorted();
    const newest = kept.at(-1);
    if (
      newest !== undefined &&
      (yield* fileSystem.readFileString(path.join(backups, newest))) === content
    ) {
      return "unchanged" as const;
    }
    const sequence = newest === undefined ? 1 : Number.parseInt(newest, 10) + 1;
    const name = `${String(sequence).padStart(6, "0")}-${DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-")}.md`;
    yield* fileSystem.writeFileString(path.join(backups, name), content);
    for (const old of [...kept, name].slice(0, -MEMORY_BACKUPS_KEPT)) {
      yield* fileSystem.remove(path.join(backups, old));
    }
    return "changed" as const;
  });

  return ThreadMemory.of({ directory, forTurn, forkNote, handOver, recordTurn });
});

export const layer = Layer.effect(ThreadMemory, make);
