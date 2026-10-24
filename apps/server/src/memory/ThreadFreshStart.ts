import {
  CommandId,
  isUserPinnedThread,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMemory from "./ThreadMemory.ts";

export class ThreadFreshStartError extends Schema.TaggedError<ThreadFreshStartError>()(
  "ThreadFreshStartError",
  {
    threadId: ThreadId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ThreadFreshStartInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly newThreadId: ThreadId;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

/**
 * Continues a pinned thread in a new one with the same title, icon, project,
 * model and modes. The new thread takes over the pin's place and the memory file;
 * the old one is settled, so exactly one thread writes the file.
 */
export class ThreadFreshStart extends Context.Service<
  ThreadFreshStart,
  {
    readonly freshStart: (
      input: ThreadFreshStartInput,
    ) => Effect.Effect<{ readonly sequence: number }, ThreadFreshStartError>;
  }
>()("t3/memory/ThreadFreshStart") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const memory = yield* ThreadMemory.ThreadMemory;

  const freshStart = Effect.fn("ThreadFreshStart.freshStart")(function* (
    input: ThreadFreshStartInput,
  ) {
    const fail = (detail: string) => (cause: unknown) =>
      new ThreadFreshStartError({ threadId: input.threadId, detail, cause });
    const { thread } = yield* threads
      .getThreadRecords(input.threadId, [])
      .pipe(Effect.mapError(fail("Could not read the thread to start fresh.")));
    // A retry of the same command finds the thread already handed over and
    // repeats the steps, which their own command ids make no-ops.
    if (thread.continuedIn !== input.newThreadId) {
      const refusal =
        thread.deletedAt !== null || thread.archivedAt !== null
          ? "An archived or deleted thread cannot start fresh."
          : thread.continuedIn !== undefined
            ? `This thread already continues in thread ${thread.continuedIn}.`
            : !isUserPinnedThread(thread)
              ? "Only a pinned thread can start fresh."
              : undefined;
      if (refusal !== undefined) {
        return yield* new ThreadFreshStartError({ threadId: input.threadId, detail: refusal });
      }
    }
    const step = (name: string) => CommandId.make(`${input.commandId}:fresh-start:${name}`);
    // First, so a thread that is still running, waits on a question or has a
    // queued message is refused before anything changes. Settling unpins it.
    yield* threads
      .dispatch({ type: "thread.settle", commandId: step("settle"), threadId: thread.id })
      .pipe(Effect.mapError(fail("Could not settle the thread to start fresh.")));
    yield* threads
      .dispatch({
        type: "thread.create",
        commandId: step("create"),
        threadId: input.newThreadId,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        continuedFrom: thread.id,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      })
      .pipe(Effect.mapError(fail("Could not create the thread to continue in.")));
    if (thread.icon != null) {
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: step("icon"),
          threadId: input.newThreadId,
          icon: thread.icon,
        })
        .pipe(Effect.mapError(fail("Could not give the new thread the old one's icon.")));
    }
    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: step("link"),
        threadId: thread.id,
        continuedIn: input.newThreadId,
      })
      .pipe(Effect.mapError(fail("Could not link the thread to its continuation.")));
    yield* memory
      .handOver(thread.id, input.newThreadId)
      .pipe(Effect.mapError(fail("Could not hand the memory file over to the new thread.")));
    return yield* threads
      .dispatch({
        type: "thread.pin",
        commandId: step("pin"),
        threadId: input.newThreadId,
        ...(thread.pinOrderKey == null ? {} : { orderKey: thread.pinOrderKey }),
      })
      .pipe(
        Effect.map((result) => ({ sequence: result.sequence })),
        Effect.mapError(fail("Could not pin the new thread.")),
      );
  });

  return ThreadFreshStart.of({ freshStart });
});

export const layer = Layer.effect(ThreadFreshStart, make);
