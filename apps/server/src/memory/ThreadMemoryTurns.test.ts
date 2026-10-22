import { assert, describe, it } from "@effect/vitest";
import { RunId, type ThreadId, threadMemoryFilePath } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadMemory from "./ThreadMemory.ts";
import { createThread, layerWithRuntime, seedProject } from "./ThreadMemory.testkit.ts";
import * as ThreadMemoryTurns from "./ThreadMemoryTurns.ts";

const layer = layerWithRuntime(Layer.empty);

const unchangedTurns = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  ).pipe(Effect.map((projection) => projection.thread.memoryUnchangedTurns ?? 0));

describe("ThreadMemoryTurns", () => {
  it.effect("counts the turns since a pinned thread's memory last changed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const memory = yield* ThreadMemory.ThreadMemory;
      const fileSystem = yield* FileSystem.FileSystem;
      const turns = yield* ThreadMemoryTurns.make;
      yield* seedProject;
      const expert = yield* createThread("expert", "a1");
      const file = threadMemoryFilePath(memory.directory, expert);
      const updatedAt = (yield* orchestrator.getThreadProjection(expert)).thread.updatedAt;

      // No notes yet still counts: the agent has not written any.
      yield* turns.recordTurn(expert, RunId.make("run:1"));
      // A run that reports its completion twice counts once.
      yield* turns.recordTurn(expert, RunId.make("run:1"));
      assert.equal(yield* unchangedTurns(expert), 1);

      yield* fileSystem.writeFileString(file, "# Expert\n");
      yield* turns.recordTurn(expert, RunId.make("run:2"));
      assert.equal(yield* unchangedTurns(expert), 0);

      yield* turns.recordTurn(expert, RunId.make("run:3"));
      yield* turns.recordTurn(expert, RunId.make("run:4"));
      assert.equal(yield* unchangedTurns(expert), 2);

      yield* fileSystem.writeFileString(file, "# Expert\nA decision.\n");
      yield* turns.recordTurn(expert, RunId.make("run:5"));
      assert.equal(yield* unchangedTurns(expert), 0);
      // Counting is bookkeeping: the thread keeps its place in update-time order.
      const thread = (yield* orchestrator.getThreadProjection(expert)).thread;
      assert.equal(thread.updatedAt.epochMilliseconds, updatedAt.epochMilliseconds);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves a thread without an active memory alone", () =>
    Effect.gen(function* () {
      const turns = yield* ThreadMemoryTurns.make;
      yield* seedProject;
      const loose = yield* createThread("loose", null);

      yield* turns.recordTurn(loose, RunId.make("run:1"));
      yield* turns.recordTurn(loose, RunId.make("run:2"));

      assert.equal(yield* unchangedTurns(loose), 0);
    }).pipe(Effect.provide(layer)),
  );
});
