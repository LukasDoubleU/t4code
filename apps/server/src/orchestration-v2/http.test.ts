import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  EventId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2AppThread,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadTail,
  OrchestrationV2ThreadTranscript,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { THREAD_TAIL_MAX_MESSAGES, THREAD_TAIL_MAX_TEXT_CHARS } from "@t3tools/shared/threadTail";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import * as OrchestrationHttp from "./http.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

class TranscriptTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadTranscript),
);

const now = DateTime.makeUnsafe("2026-09-29T00:00:00.000Z");
const environmentId = EnvironmentId.make("source-بيئة");
const output = "Full tool output. ".repeat(4_000);
const thread = Schema.decodeUnknownSync(OrchestrationV2AppThread)({
  id: "source-thread",
  projectId: "source-project",
  title: "Source 界\nconversation",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "source-thread", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});
const items = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2TurnItem))(
  Array.from({ length: 200 }, (_, position) => ({
    id: `item-${position}`,
    threadId: "source-thread",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: position,
    type: "command_execution",
    status: "completed",
    title: "Read notes",
    input: "cat notes.md",
    output: position === 0 ? output : "Done",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  })),
);

const serveOrchestrationHttp = Effect.fnUntraced(function* (name: string) {
  const access = { allowed: true };
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { runEffectWorker: false },
  );
  const services = yield* Layer.build(
    Layer.mergeAll(
      runtime,
      ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(runtime, CommandReceiptStore.layer, ServerSettings.layerTest({})),
        ),
      ),
      OrchestrationEventStore.layer,
      ProjectStore.layer,
    ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  );
  const eventSink = Context.get(services, EventSinkV2);
  yield* eventSink.write({
    events: [
      {
        id: EventId.make("create-source"),
        type: "thread.created",
        threadId: thread.id,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  const routes = HttpApiBuilder.layer(TranscriptTestApi).pipe(
    Layer.provide(OrchestrationHttp.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(
      Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
        Effect.suspend(() =>
          effect.pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, {
              sessionId: AuthSessionId.make("test-session"),
              subject: "test",
              method: "bearer-access-token",
              scopes: new Set<AuthEnvironmentScope>(access.allowed ? ["orchestration:read"] : []),
            }),
          ),
        ),
      ),
    ),
    Layer.provide(Layer.succeedContext(services)),
    Layer.provide(Layer.mock(ProjectEnrichmentService)({})),
    Layer.provide(HttpPlatform.layer),
    Layer.provide(Etag.layerWeak),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const get = (path: string) =>
    Effect.promise(() =>
      handler(
        new Request(`http://localhost${path}`, {
          headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
        }),
      ),
    );
  return { access, services, eventSink, get };
});

it.effect("exports full history with size, scope, and missing-thread checks", () =>
  Effect.gen(function* () {
    const { access, services, eventSink, get } = yield* serveOrchestrationHttp("thread-transcript");
    const read = (threadId: ThreadId) => get(`/api/orchestration/threads/${threadId}/transcript`);

    const emptyResponse = yield* read(thread.id);
    expect(emptyResponse.status).toBe(200);
    expect(
      (yield* decodeTranscript(yield* Effect.promise(() => emptyResponse.json()))).items,
    ).toEqual([]);
    yield* eventSink.write({
      events: items.map((item) => ({
        id: EventId.make(`create-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });

    const response = yield* read(thread.id);
    expect(response.status).toBe(200);
    const transcript = yield* decodeTranscript(yield* Effect.promise(() => response.json()));
    expect(transcript.items).toHaveLength(200);
    expect(transcript.items[0]?.item).toMatchObject({ output });
    expect(transcript.items[0]?.visibility).toBe("local");
    expect(transcript.items[199]?.position).toBe(199);

    const emptyOutputRows = transcript.items.map((row, position) =>
      position === 0 ? { ...row, item: { ...row.item, output: "" } } : row,
    );
    const header = threadTranscriptHeader(environmentId, transcript);
    const baseSize =
      Buffer.byteLength(header, "utf8") +
      emptyOutputRows.reduce(
        (size, row) => size + Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8"),
        0,
      );
    const boundaryOutput = "界" + "x".repeat(PROVIDER_SEND_TURN_MAX_FILE_BYTES - baseSize - 3);
    for (const [suffix, expectedStatus] of [
      ["", 200],
      ["x", 400],
    ] as const) {
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`boundary-${expectedStatus}`),
            type: "turn-item.updated",
            threadId: thread.id,
            occurredAt: now,
            payload: {
              ...items.find((item) => item.type === "command_execution")!,
              output: boundaryOutput + suffix,
            },
          },
        ],
      });
      const response = yield* read(thread.id);
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 400) {
        const error = yield* Context.get(services, ThreadManagementService.ThreadManagementService)
          .getThreadTranscript(thread.id)
          .pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(environmentId),
            }),
            Effect.flip,
          );
        expect(error).toBeInstanceOf(ThreadManagementService.ThreadTranscriptTooLargeError);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          _tag: "EnvironmentRequestInvalidError",
          reason: "thread_transcript_too_large",
        });
      }
    }

    expect((yield* read(ThreadId.make("missing"))).status).toBe(404);
    access.allowed = false;
    expect((yield* read(thread.id)).status).toBe(403);
  }),
);

const decodeTail = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2ThreadTail));
const message = (
  position: number,
  fields: {
    readonly type: "user_message" | "assistant_message";
    readonly runId: string | null;
  } & Record<string, unknown>,
) => ({
  id: `message-${position}`,
  threadId: "source-thread",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: position,
  status: "completed",
  title: null,
  startedAt: DateTime.add(now, { seconds: position }),
  completedAt: null,
  updatedAt: DateTime.add(now, { seconds: position }),
  messageId: `msg-${position}`,
  attachments: [],
  ...(fields.type === "user_message"
    ? { createdBy: "user", creationSource: "web", inputIntent: "turn_start" }
    : { streaming: false }),
  ...fields,
});

const longReply = "Reply. ".repeat(1_000);
const tailTimeline = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2TurnItem))([
  message(0, { type: "user_message", runId: "run-1", text: "Look into the flaky test" }),
  message(1, { type: "assistant_message", runId: "run-1", text: "Looking at the logs first." }),
  { ...items[1]!, id: "work", ordinal: 2, runId: "run-1" },
  message(3, { type: "assistant_message", runId: "run-1", text: longReply }),
  message(4, {
    type: "user_message",
    runId: "run-2",
    text: "Status?",
    createdBy: "agent",
    creationSource: "mcp",
    senderThreadId: "other-thread",
  }),
  message(5, { type: "assistant_message", runId: "run-2", text: "Still green." }),
]);
const tailNotes = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2TurnItem))(
  Array.from({ length: THREAD_TAIL_MAX_MESSAGES }, (_, index) =>
    message(10 + index, { type: "user_message", runId: null, text: `Note ${index}` }),
  ),
);

it.effect("reads a thread's last messages and replies, clamped and capped", () =>
  Effect.gen(function* () {
    const { access, eventSink, get } = yield* serveOrchestrationHttp("thread-tail");
    yield* eventSink.write({
      events: tailTimeline.map((item) => ({
        id: EventId.make(`tail-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });
    const readTail = (query = "") =>
      get(`/api/orchestration/threads/${thread.id}/tail${query}`).pipe(
        Effect.flatMap((response) => {
          expect(response.status).toBe(200);
          return Effect.promise(() => response.json());
        }),
        Effect.flatMap(decodeTail),
      );

    const tail = yield* readTail();
    expect(tail.messages.map((entry) => [entry.role, entry.messageId])).toEqual([
      ["user", "msg-0"],
      ["assistant", "msg-3"],
      ["user", "msg-4"],
      ["assistant", "msg-5"],
    ]);
    expect(tail.messages[1]).toMatchObject({
      text: longReply.slice(0, THREAD_TAIL_MAX_TEXT_CHARS),
      textTruncated: true,
    });
    expect(tail.messages[2]).toMatchObject({
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: "other-thread",
      textTruncated: false,
      createdAt: "2026-09-29T00:00:04.000Z",
    });
    expect((yield* readTail("?limit=2")).messages.map((entry) => entry.messageId)).toEqual([
      "msg-4",
      "msg-5",
    ]);

    yield* eventSink.write({
      events: tailNotes.map((item) => ({
        id: EventId.make(`tail-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });
    expect((yield* readTail("?limit=1000")).messages).toHaveLength(THREAD_TAIL_MAX_MESSAGES);

    expect((yield* get("/api/orchestration/threads/missing/tail")).status).toBe(404);
    access.allowed = false;
    expect((yield* get(`/api/orchestration/threads/${thread.id}/tail`)).status).toBe(403);
  }),
);
