import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadMemory from "./ThreadMemory.ts";

// The T3 home is a fresh temporary directory, never the real one.
const layerWithSetting = (pinnedThreadsKeepMemory: boolean) =>
  ThreadMemory.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-memory-" })),
    Layer.provideMerge(ServerSettings.layerTest({ pinnedThreadsKeepMemory })),
    Layer.provideMerge(NodeServices.layer),
  );

const threadId = ThreadId.make("thread:pinned-expert");

describe("ThreadMemory", () => {
  it.effect("gives a pinned thread its memory file and the line that points at it", () =>
    Effect.gen(function* () {
      const memory = yield* ThreadMemory.ThreadMemory;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const expectedPath = path.join(config.stateDir, "memory", "thread_pinned-expert.md");

      const turn = yield* memory.forTurn({ id: threadId, pinnedAt: yield* DateTime.now });

      assert.deepEqual(turn, {
        path: expectedPath,
        instructions: ThreadMemory.threadMemoryInstructions(expectedPath),
      });
      assert.include(turn?.instructions ?? "", `memory file: ${expectedPath}`);
      assert.include(turn?.instructions ?? "", "after every compaction");
      assert.equal(memory.directory, path.dirname(expectedPath));
      // The agent creates the file; the folder is there for it.
      assert.isTrue(yield* fileSystem.exists(memory.directory));
      assert.isFalse(yield* fileSystem.exists(expectedPath));
    }).pipe(Effect.provide(layerWithSetting(true))),
  );

  it.effect("lets the memory of an unpinned thread sleep", () =>
    Effect.gen(function* () {
      const memory = yield* ThreadMemory.ThreadMemory;
      assert.isUndefined(yield* memory.forTurn({ id: threadId, pinnedAt: null }));
      assert.isUndefined(yield* memory.forTurn({ id: threadId }));
    }).pipe(Effect.provide(layerWithSetting(true))),
  );

  it.effect("lets every memory sleep while the setting is off", () =>
    Effect.gen(function* () {
      const memory = yield* ThreadMemory.ThreadMemory;
      assert.isUndefined(yield* memory.forTurn({ id: threadId, pinnedAt: yield* DateTime.now }));
    }).pipe(Effect.provide(layerWithSetting(false))),
  );
});
