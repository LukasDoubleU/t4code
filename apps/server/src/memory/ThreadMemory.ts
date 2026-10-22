import {
  isUserPinnedThread,
  threadMemoryFilePath,
  type OrchestrationV2AppThread,
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

export class ThreadMemory extends Context.Service<
  ThreadMemory,
  {
    readonly directory: string;
    /** The memory a turn of this thread carries, or undefined while it sleeps. */
    readonly forTurn: (
      thread: Pick<OrchestrationV2AppThread, "id" | "pinnedAt" | "lineage">,
    ) => Effect.Effect<{ readonly path: string; readonly instructions: string } | undefined>;
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

  return ThreadMemory.of({ directory, forTurn });
});

export const layer = Layer.effect(ThreadMemory, make);
