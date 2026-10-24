import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

it.effect("skips the project's setup script for work a link below full access started", () => {
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Shell",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }),
  );
  const projectId = ProjectId.make("project:setup-runner-link");
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "vp install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
    ],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          open,
          write: () => Effect.void,
          subscribe: () => Effect.succeed(() => undefined),
          closeIdle: () => Effect.void,
        }),
        // `thread-linked` was started from a linked environment, `thread-trusted`
        // from one linked with full access; `thread-unread` cannot be read.
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: (threadId) =>
            threadId === ThreadId.make("thread-unread")
              ? Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }))
              : Effect.succeed(
                  threadId === ThreadId.make("thread-linked")
                    ? {
                        ...liveThreadShell(threadId),
                        linkOrigin: { sessionId: "s", label: "Laptop", access: "auto" as const },
                      }
                    : threadId === ThreadId.make("thread-trusted")
                      ? {
                          ...liveThreadShell(threadId),
                          linkOrigin: {
                            sessionId: "t",
                            label: "Desk",
                            access: "full-access" as const,
                          },
                        }
                      : null,
                ),
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    // The project's own script never runs for work a link below full access started.
    const linked = yield* runner.runForThread({
      threadId: "thread-linked",
      projectId,
      worktreePath: "/repo-worktree",
    });
    assert.deepEqual(linked, { status: "skipped-for-link" });
    // Nor for one whose origin cannot be read.
    const unread = yield* runner
      .runForThread({ threadId: "thread-unread", projectId, worktreePath: "/repo-worktree" })
      .pipe(Effect.flip);
    assert.equal(unread._tag, "ProjectSetupScriptOperationError");
    assert.equal(open.mock.calls.length, 0);
    // A full-access link's work runs as this environment's own.
    const trusted = yield* runner.runForThread({
      threadId: "thread-trusted",
      projectId,
      worktreePath: "/repo-worktree",
    });
    assert.equal(trusted.status, "started");
    assert.equal(open.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});
