import {
  isUserPinnedThread,
  threadMemoryFilePath,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * The same text on every turn of a thread, so the provider's prompt cache
 * stays valid until the thread is pinned, unpinned or the setting changes.
 */
export function threadMemoryInstructions(path: string): string {
  return [
    `This thread keeps a memory file: ${path}`,
    "Read it at the start of a session and again after every compaction.",
    "Keep it current: the thread's purpose, the current state, decisions and their reasons, the user's preferences, and open points.",
    "Not the history, which stays in the thread. Keep it under about 8k tokens and never put secrets in it.",
    "Create it the first time there is something worth keeping.",
  ].join(" ");
}

/** For a fork whose copied history points at its source thread's memory file. */
export function threadMemoryForkNote(sourcePath: string): string {
  return [
    `This thread was forked from another thread. The memory file named earlier in this conversation, ${sourcePath}, belongs to that thread, not to this one.`,
    "Don't create, update or overwrite it. Reading it for context is fine.",
  ].join(" ");
}

export class ThreadMemory extends Context.Service<
  ThreadMemory,
  {
    readonly directory: string;
    /** The memory a turn of this thread carries, or undefined while it sleeps. */
    readonly forTurn: (
      thread: Pick<OrchestrationV2AppThread, "id" | "pinnedAt" | "lineage">,
    ) => Effect.Effect<{ readonly path: string; readonly instructions: string } | undefined>;
    /**
     * The note for a native fork's first turn, or undefined when its source
     * never kept a memory its history could name.
     */
    readonly forkNote: (source: {
      readonly id: ThreadId;
      readonly pinned: boolean;
    }) => Effect.Effect<string | undefined>;
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

  const forTurn = Effect.fn("ThreadMemory.forTurn")(function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "pinnedAt" | "lineage">,
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
    return { path: memoryPath, instructions: threadMemoryInstructions(memoryPath) };
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

  return ThreadMemory.of({ directory, forTurn, forkNote });
});

export const layer = Layer.effect(ThreadMemory, make);
