import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ProviderTurn,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  threadMemoryFilePath,
} from "@t3tools/contracts";
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
const lineage = { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId };

describe("ThreadMemory", () => {
  it.effect("gives a pinned thread its memory file and the line that points at it", () =>
    Effect.gen(function* () {
      const memory = yield* ThreadMemory.ThreadMemory;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const expectedPath = path.join(config.stateDir, "memory", "thread_pinned-expert.md");

      const turn = yield* memory.forTurn({ id: threadId, pinnedAt: yield* DateTime.now, lineage });

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
      assert.isUndefined(yield* memory.forTurn({ id: threadId, pinnedAt: null, lineage }));
      assert.isUndefined(yield* memory.forTurn({ id: threadId, lineage }));
    }).pipe(Effect.provide(layerWithSetting(true))),
  );

  it.effect("gives no memory to a delegated task or subagent that copied its parent's pin", () =>
    Effect.gen(function* () {
      const memory = yield* ThreadMemory.ThreadMemory;
      const child = yield* memory.forTurn({
        id: ThreadId.make("thread:delegated-task"),
        pinnedAt: yield* DateTime.now,
        lineage: {
          parentThreadId: threadId,
          relationshipToParent: "subagent",
          rootThreadId: threadId,
        },
      });
      assert.isUndefined(child);
    }).pipe(Effect.provide(layerWithSetting(true))),
  );

  it.effect("warns a fork off the memory file of a source that kept one", () =>
    Effect.gen(function* () {
      const memory = yield* ThreadMemory.ThreadMemory;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourcePath = path.join(memory.directory, "thread_pinned-expert.md");
      const note = ThreadMemory.threadMemoryForkNote(sourcePath);

      assert.equal(yield* memory.forkNote({ id: threadId, pinned: true }), note);
      assert.include(note, sourcePath);
      assert.isUndefined(yield* memory.forkNote({ id: threadId, pinned: false }));

      // Unpinned since, but its file stays and the fork's history may name it.
      yield* fileSystem.makeDirectory(memory.directory, { recursive: true });
      yield* fileSystem.writeFileString(sourcePath, "# Notes\n");
      assert.equal(yield* memory.forkNote({ id: threadId, pinned: false }), note);
    }).pipe(Effect.provide(layerWithSetting(true))),
  );

  it.effect("lets every memory sleep while the setting is off", () =>
    Effect.gen(function* () {
      const memory = yield* ThreadMemory.ThreadMemory;
      assert.isUndefined(
        yield* memory.forTurn({ id: threadId, pinnedAt: yield* DateTime.now, lineage }),
      );
    }).pipe(Effect.provide(layerWithSetting(false))),
  );

  it.effect("keeps each new version of the file, the last 20 of them", () =>
    Effect.gen(function* () {
      const memory = yield* ThreadMemory.ThreadMemory;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = threadMemoryFilePath(memory.directory, threadId);
      const backups = path.join(memory.directory, "backups", "thread_pinned-expert");
      yield* fileSystem.makeDirectory(memory.directory, { recursive: true });

      assert.equal(yield* memory.recordTurn(threadId), "missing");
      for (let version = 1; version <= 25; version++) {
        yield* fileSystem.writeFileString(file, `version ${version}`);
        assert.equal(yield* memory.recordTurn(threadId), "changed");
        assert.equal(yield* memory.recordTurn(threadId), "unchanged");
      }

      const kept = (yield* fileSystem.readDirectory(backups)).toSorted();
      assert.lengthOf(kept, ThreadMemory.MEMORY_BACKUPS_KEPT);
      const contents = yield* Effect.forEach(kept, (name) =>
        fileSystem.readFileString(path.join(backups, name)),
      );
      // A bad overwrite is restored by copying the version before it back.
      assert.deepEqual(
        contents,
        Array.from({ length: 20 }, (_, index) => `version ${index + 6}`),
      );
    }).pipe(Effect.provide(layerWithSetting(true))),
  );

  it.effect("hands the file and its backups over to the thread that continues it", () =>
    Effect.gen(function* () {
      const memory = yield* ThreadMemory.ThreadMemory;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = ThreadId.make("thread:next-expert");
      const file = threadMemoryFilePath(memory.directory, threadId);
      yield* fileSystem.makeDirectory(memory.directory, { recursive: true });
      yield* fileSystem.writeFileString(file, "# Notes\n");
      yield* memory.recordTurn(threadId);

      yield* memory.handOver(threadId, next);

      assert.isFalse(yield* fileSystem.exists(file));
      assert.equal(
        yield* fileSystem.readFileString(threadMemoryFilePath(memory.directory, next)),
        "# Notes\n",
      );
      // Its backups came along: the same version is not kept twice.
      assert.equal(yield* memory.recordTurn(next), "unchanged");
      assert.equal(yield* memory.recordTurn(threadId), "missing");
      // Nothing to hand over is not an error.
      yield* memory.handOver(threadId, ThreadId.make("thread:third"));
    }).pipe(Effect.provide(layerWithSetting(true))),
  );

  it.effect("tells a continuing thread whose memory it took over", () =>
    Effect.gen(function* () {
      const memory = yield* ThreadMemory.ThreadMemory;
      const source = ThreadId.make("thread:old-expert");
      const turn = yield* memory.forTurn({
        id: threadId,
        pinnedAt: yield* DateTime.now,
        lineage,
        continuedFrom: source,
      });
      assert.include(turn?.instructions ?? "", `continues thread ${source}`);
      assert.include(turn?.instructions ?? "", "after every compaction");
    }).pipe(Effect.provide(layerWithSetting(true))),
  );
});

describe("memoryNudgeDue", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread:expert");
  const report = (
    attempt: number,
    usedTokens: number,
    options: { readonly maxTokens?: number | null; readonly providerThread?: string } = {},
  ): Pick<
    OrchestrationV2ProviderTurn,
    "id" | "providerThreadId" | "runAttemptId" | "tokenUsage"
  > => ({
    id: ProviderTurnId.make(`provider-turn:${attempt}`),
    providerThreadId: ProviderThreadId.make(options.providerThread ?? providerThreadId),
    runAttemptId: RunAttemptId.make(`attempt:${attempt}`),
    tokenUsage: {
      usedTokens,
      maxTokens: options.maxTokens === undefined ? 200_000 : options.maxTokens,
      updatedAt: `2026-10-22T12:${String(attempt).padStart(2, "0")}:00.000Z`,
    },
  });
  const due = (turns: ReadonlyArray<ReturnType<typeof report>>) =>
    ThreadMemory.memoryNudgeDue(turns, providerThreadId);

  it("reminds once per approach to the limit", () => {
    const history = [report(1, 120_000), report(2, 160_000)];
    assert.isFalse(due(history));
    // Past 85 % of the window: the next turn carries the reminder.
    history.push(report(3, 175_000));
    assert.isTrue(due(history));
    // That turn ran close to the limit too, so the one after hears nothing.
    history.push(report(4, 185_000));
    assert.isFalse(due(history));
    // A compaction brought it down; the next approach reminds again.
    history.push(report(5, 40_000), report(6, 120_000));
    assert.isFalse(due(history));
    history.push(report(7, 172_000));
    assert.isTrue(due(history));
  });

  it("measures against the compaction threshold when it is lower than the window", () => {
    const turn = report(1, 130_000, { maxTokens: 1_000_000 });
    assert.isFalse(due([turn]));
    assert.isTrue(
      due([{ ...turn, tokenUsage: { ...turn.tokenUsage!, autoCompactThreshold: 150_000 } }]),
    );
  });

  it("stays quiet without a known window or for another provider thread", () => {
    assert.isFalse(due([report(1, 190_000, { maxTokens: null })]));
    assert.isFalse(due([report(1, 190_000, { providerThread: "provider-thread:other" })]));
    assert.isFalse(due([]));
  });
});
