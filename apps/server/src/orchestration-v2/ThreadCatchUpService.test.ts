import { assert, describe, it, vi } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadCatchUp from "./ThreadCatchUpService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const projectId = ProjectId.make("project:catch-up");
const threadId = ThreadId.make("thread:catch-up");
const runId = RunId.make("run:catch-up");
const titleModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex-mini" };
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 12, minute));

const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: "Catch up",
  providerInstanceId: titleModel.instanceId,
  modelSelection: titleModel,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at(0),
  updatedAt: at(9),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: at(2),
  deletedAt: null,
};

function message(
  minute: number,
  role: "user" | "assistant",
  text: string,
): OrchestrationV2ConversationMessage {
  return {
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(`message-${minute}`),
    threadId,
    runId,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdAt: at(minute),
    updatedAt: at(minute),
  };
}

const run: OrchestrationV2Run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: titleModel.instanceId,
  modelSelection: titleModel,
  providerThreadId: null,
  userMessageId: MessageId.make("message-3"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "waiting",
  requestedAt: at(3),
  startedAt: at(3),
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};

const approval: OrchestrationV2TurnItem = {
  id: TurnItemId.make("item-approval"),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 2,
  status: "waiting",
  title: null,
  startedAt: at(5),
  completedAt: null,
  updatedAt: at(5),
  type: "approval_request",
  requestId: RuntimeRequestId.make("request-approval"),
  requestKind: "command",
  prompt: "Run the database migration",
};

const pendingApproval: OrchestrationV2RuntimeRequest = {
  id: RuntimeRequestId.make("request-approval"),
  nodeId: NodeId.make("node-approval"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: at(5),
  resolvedAt: null,
};

function makeHarness(input: {
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runtimeRequests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly turnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly brief: {
    readonly needsYou: string | null;
    readonly happened: ReadonlyArray<string>;
    readonly next: string;
  };
}) {
  const records = {
    thread,
    messages: input.messages,
    runs: [run],
    runtimeRequests: input.runtimeRequests ?? [],
    turnItems: input.turnItems ?? [],
  };
  const generateThreadCatchUp = vi.fn(
    (_request: Parameters<TextGeneration.TextGeneration["Service"]["generateThreadCatchUp"]>[0]) =>
      Effect.succeed(input.brief),
  );
  const layer = ThreadCatchUp.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        // Reads only: a dispatch would hit this mock's missing method and fail the test.
        Layer.mock(ThreadManagement.ThreadManagementService)({
          // The fixture holds every field the service asks for.
          getThreadRecords: () => Effect.succeed(records as never),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: titleModel,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
              deletedAt: null,
            }),
        }),
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadCatchUp }),
        ServerSettings.layerTest({ textGenerationModelSelection: titleModel }),
      ),
    ),
  );
  return { layer, generateThreadCatchUp };
}

describe("ThreadCatchUpService", () => {
  it.effect("briefs from the thread since the user's last message with the title model", () => {
    const harness = makeHarness({
      messages: [
        message(1, "user", "an older ask"),
        message(3, "user", "Add a dark mode toggle"),
        message(6, "assistant", "Added the toggle and its tests."),
      ],
      brief: { needsYou: null, happened: ["Added the toggle"], next: "Nothing is running." },
    });
    return Effect.gen(function* () {
      const service = yield* ThreadCatchUp.ThreadCatchUpService;
      const brief = yield* service.catchUp({ threadId });

      assert.strictEqual(brief.needsYou, null);
      assert.deepStrictEqual(brief.happened, ["Added the toggle"]);
      assert.strictEqual(brief.next, "Nothing is running.");
      const request = harness.generateThreadCatchUp.mock.calls[0]![0];
      assert.strictEqual(request.modelSelection.instanceId, titleModel.instanceId);
      assert.strictEqual(request.modelSelection.model, titleModel.model);
      assert.strictEqual(request.cwd, "/repo");
      // The last visit (minute 2) is earlier than the user's latest message (minute 3).
      assert.strictEqual(
        request.items,
        "You: Add a dark mode toggle\nAgent: Added the toggle and its tests.",
      );
      assert.deepStrictEqual(request.waitingOnUser, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps an open approval in Needs you when the model leaves it out", () => {
    const harness = makeHarness({
      messages: [message(3, "user", "Ship the release")],
      runtimeRequests: [pendingApproval],
      turnItems: [approval],
      brief: { needsYou: null, happened: ["Prepared the release"], next: "Waits for you." },
    });
    return Effect.gen(function* () {
      const service = yield* ThreadCatchUp.ThreadCatchUpService;
      const brief = yield* service.catchUp({ threadId });

      assert.strictEqual(
        brief.needsYou,
        "The agent waits for your approval: Run the database migration",
      );
      assert.deepStrictEqual(harness.generateThreadCatchUp.mock.calls[0]![0].waitingOnUser, [
        "The agent waits for your approval: Run the database migration",
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers an empty thread without running a model", () => {
    const harness = makeHarness({
      messages: [],
      brief: { needsYou: "unused", happened: [], next: "unused" },
    });
    return Effect.gen(function* () {
      const service = yield* ThreadCatchUp.ThreadCatchUpService;
      const brief = yield* service.catchUp({ threadId });

      assert.strictEqual(brief.needsYou, null);
      assert.strictEqual(harness.generateThreadCatchUp.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
