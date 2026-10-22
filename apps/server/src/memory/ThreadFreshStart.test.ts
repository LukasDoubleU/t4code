import { assert, describe, it } from "@effect/vitest";
import { CommandId, ThreadId, threadMemoryFilePath } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadFreshStart from "./ThreadFreshStart.ts";
import * as ThreadMemory from "./ThreadMemory.ts";
import {
  createThread,
  layerWithRuntime,
  modelSelection,
  seedProject,
} from "./ThreadMemory.testkit.ts";

const layer = layerWithRuntime(ThreadFreshStart.layer);
const continuation = ThreadId.make("thread:expert-continued");

const freshStart = (threadId: ThreadId, newThreadId = continuation, commandId = "fresh") =>
  Effect.flatMap(ThreadFreshStart.ThreadFreshStart, (service) =>
    service.freshStart({
      commandId: CommandId.make(commandId),
      threadId,
      newThreadId,
      createdBy: "user",
      creationSource: "web",
    }),
  );

describe("ThreadFreshStart", () => {
  it.effect("continues a pinned thread in a new one that takes its pin and its memory", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const memory = yield* ThreadMemory.ThreadMemory;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* seedProject;
      yield* createThread("before", "a0");
      const expert = yield* createThread("expert", "a1");
      yield* createThread("after", "a2");
      const oldFile = threadMemoryFilePath(memory.directory, expert);
      yield* fileSystem.makeDirectory(memory.directory, { recursive: true });
      yield* fileSystem.writeFileString(oldFile, "# Expert\nKnows the release process.\n");
      assert.equal(yield* memory.recordTurn(expert), "changed");

      yield* freshStart(expert);

      const old = (yield* orchestrator.getThreadProjection(expert)).thread;
      const next = (yield* orchestrator.getThreadProjection(continuation)).thread;
      assert.equal(old.settledOverride, "settled");
      assert.isNull(old.pinnedAt ?? null);
      assert.equal(old.continuedIn, continuation);
      assert.equal(next.continuedFrom, expert);
      assert.isNotNull(next.pinnedAt ?? null);
      // The old thread's slot in the pinned order.
      assert.equal(next.pinOrderKey, "a1");
      assert.equal(next.title, "expert");
      assert.deepEqual(next.modelSelection, modelSelection);
      assert.equal(next.runtimeMode, "full-access");
      assert.equal(next.branch, "main");

      // Only the new thread has the file now, backups included.
      const newFile = threadMemoryFilePath(memory.directory, continuation);
      assert.isFalse(yield* fileSystem.exists(oldFile));
      assert.equal(
        yield* fileSystem.readFileString(newFile),
        "# Expert\nKnows the release process.\n",
      );
      assert.equal(yield* memory.recordTurn(continuation), "unchanged");
      const turn = yield* memory.forTurn(next);
      assert.equal(turn?.path, newFile);
      assert.include(turn?.instructions ?? "", `continues thread ${expert}`);
      assert.isUndefined(yield* memory.forTurn(old));

      // An agent looking the expert up by name finds the new thread.
      const pinned = yield* threads.listPinnedThreads();
      assert.deepEqual(
        pinned.filter((thread) => thread.title === "expert").map((thread) => thread.id),
        [continuation],
      );
      const shell = pinned.find((thread) => thread.id === continuation);
      assert.equal(shell?.continuedFrom, expert);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("repeats a retried command without starting a second thread", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* seedProject;
      const expert = yield* createThread("expert", "a1");

      yield* freshStart(expert);
      yield* freshStart(expert);

      const pinned = yield* threads.listPinnedThreads();
      assert.deepEqual(
        pinned.map((thread) => thread.id),
        [continuation],
      );
      // A second fresh start of the old thread is refused, naming where it continues.
      const again = yield* freshStart(expert, ThreadId.make("thread:third"), "again").pipe(
        Effect.flip,
      );
      assert.include(again.message, continuation);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a thread that is not pinned and changes nothing", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* seedProject;
      const loose = yield* createThread("loose", null);

      const error = yield* freshStart(loose).pipe(Effect.flip);

      assert.equal(error.message, "Only a pinned thread can start fresh.");
      const thread = (yield* orchestrator.getThreadProjection(loose)).thread;
      assert.isNull(thread.settledOverride);
      assert.isUndefined(thread.continuedIn);
      const created = yield* orchestrator.getThreadProjection(continuation).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      assert.isFalse(created);
    }).pipe(Effect.provide(layer)),
  );
});
