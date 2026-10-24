import {
  OrchestrationV2CatchUpThreadError,
  type OrchestrationV2ThreadCatchUp,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  CATCH_UP_TURN_ITEM_TYPES,
  catchUpItemsText,
  catchUpRunIds,
  catchUpStart,
  catchUpWaitingOnUser,
} from "./threadCatchUpInput.ts";

/**
 * Writes the "Catch me up" brief. It only reads: no command is dispatched, so the brief is not a
 * message, starts no turn, and does not count as a visit or as activity.
 */
export class ThreadCatchUpService extends Context.Service<
  ThreadCatchUpService,
  {
    readonly catchUp: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<OrchestrationV2ThreadCatchUp, OrchestrationV2CatchUpThreadError>;
  }
>()("t3/orchestration-v2/ThreadCatchUpService") {}

const failure = (detail: string) => (cause: unknown) =>
  new OrchestrationV2CatchUpThreadError({ detail, cause });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const catchUp: ThreadCatchUpService["Service"]["catchUp"] = Effect.fn(
    "ThreadCatchUpService.catchUp",
  )(function* (input) {
    const records = yield* threads
      .getThreadRecords(input.threadId, ["messages", "runs", "runtimeRequests"])
      .pipe(Effect.mapError(failure("This thread is no longer available.")));
    const { thread } = records;
    const start = catchUpStart({ messages: records.messages, lastVisitedAt: thread.lastVisitedAt });
    const runIds = catchUpRunIds(records.runs, start);
    const { turnItems } =
      runIds.length === 0
        ? { turnItems: [] }
        : yield* threads
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemRunIds: runIds,
              turnItemTypes: CATCH_UP_TURN_ITEM_TYPES,
            })
            .pipe(Effect.mapError(failure("This thread is no longer available.")));
    const items = catchUpItemsText({ start, messages: records.messages, turnItems });
    const waitingOnUser = catchUpWaitingOnUser({
      attention: thread.attention,
      runtimeRequests: records.runtimeRequests,
      turnItems,
    });
    const generatedAt = DateTime.formatIso(yield* DateTime.now);
    if (items.length === 0 && waitingOnUser.length === 0) {
      return { needsYou: null, happened: [], next: "Nothing has happened here yet.", generatedAt };
    }

    const project = yield* projects
      .get(thread.projectId)
      .pipe(Effect.mapError(failure("Could not read this thread's project.")));
    if (Option.isNone(project)) {
      return yield* new OrchestrationV2CatchUpThreadError({
        detail: "This thread's project is no longer available.",
      });
    }
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(Effect.mapError(failure("Could not read settings."))),
      thread.projectId,
    ).settings;
    const brief = yield* textGeneration
      .generateThreadCatchUp({
        cwd: thread.worktreePath ?? project.value.workspaceRoot,
        items,
        waitingOnUser,
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(Effect.mapError((error) => failure(error.detail)(error)));
    return {
      // An open approval, question or call for the user always needs them, whatever the model says.
      needsYou: brief.needsYou ?? waitingOnUser[0] ?? null,
      happened: brief.happened,
      next: brief.next,
      generatedAt,
    };
  });

  return ThreadCatchUpService.of({ catchUp });
});

export const layer = Layer.effect(ThreadCatchUpService, make);
