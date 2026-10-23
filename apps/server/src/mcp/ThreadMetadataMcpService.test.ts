import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadMetadataMcp from "./ThreadMetadataMcpService.ts";

const threadId = ThreadId.make("thread:metadata-caller");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:metadata-test"),
  requestNamespace: "provider-session:metadata-test",
  thread: {
    threadId,
    providerSessionId: "provider-session:metadata-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function layerService(
  getThreadShell: ThreadManagement.ThreadManagementService["Service"]["getThreadShell"],
) {
  return ThreadMetadataMcp.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell,
          getThreadRecords: () => Effect.die("projection must not load after shell failure"),
        } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );
}

const updateCallingThread = Effect.gen(function* () {
  const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
  return yield* service.update(scope, {
    action: "rename",
    title: "Renamed thread",
    clientRequestId: "metadata-caller-classification",
  });
});

it.effect("reports an absent calling thread as thread_not_found", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(layerService(() => Effect.succeed(null))),
      Effect.flip,
    );

    expect(error.code).toBe("thread_not_found");
  }),
);

it.effect("keeps calling-thread storage failures as orchestration errors", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(
        layerService(() =>
          Effect.fail(
            new Orchestrator.OrchestratorProjectionError({
              threadId,
              cause: new Error("storage unavailable"),
            }),
          ),
        ),
      ),
      Effect.flip,
    );

    expect(error.code).toBe("orchestration_error");
  }),
);

it.effect("marks only the calling thread, as one line, and needs a calling thread", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const layer = ThreadMetadataMcp.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) => {
              dispatched.push(command);
              return Effect.succeed({ sequence: 1, storedEvents: [] });
            },
          } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
          NodeCrypto.layer,
        ),
      ),
    );
    const request = (
      requestScope: McpInvocationContext.McpInvocationScope,
      input: { readonly reason?: string; readonly clear?: boolean },
    ) =>
      Effect.gen(function* () {
        const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
        return yield* service.requestAttention(requestScope, input);
      }).pipe(Effect.provide(layer));

    yield* request(scope, { reason: "Pick a\n  release date" });
    yield* request(scope, { clear: true });
    expect(dispatched).toMatchObject([
      { type: "thread.metadata.update", threadId, attention: { reason: "Pick a release date" } },
      { type: "thread.metadata.update", threadId, attention: null },
    ]);

    const error = yield* request({ ...scope, thread: undefined }, { clear: true }).pipe(
      Effect.flip,
    );
    expect(error.code).toBe("target_required");
    expect(dispatched).toHaveLength(2);
  }),
);
