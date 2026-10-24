import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type ThreadMetadataMcpUpdateInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadMetadataMcp from "./ThreadMetadataMcpService.ts";

const threadId = ThreadId.make("thread:icon-target");
const projectId = ProjectId.make("project:icon-test");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:icon-test"),
  requestNamespace: "provider-session:icon-test",
  thread: {
    threadId: ThreadId.make("thread:icon-caller"),
    providerSessionId: "provider-session:icon-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

it.effect("sets and clears another thread's icon and answers with it", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const updatedAt = DateTime.makeUnsafe("2026-10-24T08:00:00.000Z");
    const layer = ThreadMetadataMcp.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed({ projectId, deletedAt: null } as never),
            getProjectThreadRecords: () => Effect.succeed({ thread: { projectId } } as never),
            dispatch: (command) => {
              dispatched.push(command);
              const icon =
                command.type === "thread.metadata.update" ? (command.icon ?? null) : null;
              const thread = {
                id: threadId,
                title: "Docs",
                titleRegeneration: null,
                linkedPullRequest: null,
                icon,
                updatedAt,
              } as unknown as OrchestrationV2AppThread;
              return Effect.succeed({
                sequence: dispatched.length,
                storedEvents: [
                  {
                    sequence: dispatched.length,
                    commandId: null,
                    event: { type: "thread.metadata-updated", threadId, payload: thread },
                  } as never,
                ],
              });
            },
          } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
          NodeCrypto.layer,
        ),
      ),
    );
    const update = (input: ThreadMetadataMcpUpdateInput) =>
      Effect.gen(function* () {
        const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
        return yield* service.update(scope, input);
      }).pipe(Effect.provide(layer));

    const icon = { kind: "emoji", emoji: "x" } as const;
    const set = yield* update({ threadId, action: "set_icon", icon });
    const cleared = yield* update({ threadId, action: "clear_icon" });

    expect(dispatched).toMatchObject([
      { type: "thread.metadata.update", threadId, icon },
      { type: "thread.metadata.update", threadId, icon: null },
    ]);
    expect(dispatched[0]).not.toHaveProperty("title");
    expect(set).toMatchObject({ threadId, action: "set_icon", icon });
    expect(cleared).toMatchObject({ threadId, action: "clear_icon", icon: null });
  }),
);
