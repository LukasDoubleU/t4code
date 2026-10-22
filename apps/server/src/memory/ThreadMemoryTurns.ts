import { CommandId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadMemory from "./ThreadMemory.ts";

/**
 * At the end of each completed turn of a thread whose memory is active, keeps
 * a copy of the memory file when it changed and counts the turns since it
 * last did. Turn ends are the only time it looks, so nothing watches the folder.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const memory = yield* ThreadMemory.ThreadMemory;
  // A run can report completion more than once; it counts once.
  const counted = new Map<ThreadId, RunId>();

  const recordTurn = Effect.fn("ThreadMemoryTurns.recordTurn")(
    function* (threadId: ThreadId, runId: RunId) {
      if (counted.get(threadId) === runId) return;
      counted.set(threadId, runId);
      const thread = yield* projections.getThread(threadId);
      if ((yield* memory.forTurn(thread)) === undefined) return;
      const record = yield* memory.recordTurn(threadId);
      const previous = thread.memoryUnchangedTurns ?? 0;
      const next = record === "changed" ? 0 : previous + 1;
      if (next === previous) return;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`server:memory-turn:${threadId}:${runId}`),
        threadId,
        memoryUnchangedTurns: next,
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Thread memory skipped a turn's end.", { threadId, cause }),
        ),
      ),
  );

  const start = Effect.fn("ThreadMemoryTurns.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? recordTurn(event.threadId, event.payload.id)
          : Effect.void,
      ),
    );
  });
  return { start, recordTurn };
});
