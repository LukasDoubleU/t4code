import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ExecutionEnvironmentDescriptor,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const desk = descriptorOf("environment-desk", "Desk");

const agent = ThreadId.make("thread:laptop-agent");
/** Work the desk's link started on this laptop. */
const fromDesk = ThreadId.make("thread:laptop-from-desk");
const run = RunId.make("run:lookup");

const thread = (
  id: string,
  project: string,
  options: { readonly pinned?: boolean; readonly updatedAt?: string } = {},
): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(ThreadId.make(id), { runtimeMode: "auto" }),
  projectId: ProjectId.make(project),
  pinnedAt: options.pinned === true ? DateTime.makeUnsafe("2026-10-01T00:00:00.000Z") : null,
  updatedAt: DateTime.makeUnsafe(options.updatedAt ?? "2026-10-02T00:00:00.000Z"),
});

/** One environment's threads and projects; every send there is recorded. */
const environmentThreads = (
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  sends: Ref.Ref<ReadonlyArray<ThreadId>>,
) => {
  const shellOf = (threadId: ThreadId) =>
    Effect.succeed(shells.find((shell) => shell.id === threadId) ?? null);
  const projectionOf = (threadId: ThreadId) =>
    shellOf(threadId).pipe(
      Effect.flatMap((shell) =>
        shell === null
          ? Effect.fail(
              new ThreadManagement.ThreadManagementThreadNotFoundError({
                projectId: ProjectId.make("project:none"),
                threadId,
              }),
            )
          : Effect.succeed(idleThreadProjection(shell) as never),
      ),
    );
  return Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: shellOf,
      getProjectThreadRecords: (input) => projectionOf(input.threadId),
      // Only ever asked for a thread that exists: the caller, or a target already found.
      getThreadRecords: (threadId) => projectionOf(threadId).pipe(Effect.orDie),
      getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false } as never),
      listPinnedThreads: () => Effect.succeed(shells.filter((shell) => shell.pinnedAt != null)),
      listProjectThreads: ({ projectId }) =>
        Effect.succeed(shells.filter((shell) => shell.projectId === projectId)),
      sendToThread: (input) =>
        Ref.update(sends, (sent) => [...sent, input.threadId]).pipe(
          Effect.as({ run: { id: run, status: "running" }, delivery: "started" } as never),
        ),
      waitForThread: (input) =>
        Effect.succeed({
          threadId: input.threadId,
          run: { id: run, status: "completed" },
          timedOut: false,
        } as never),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(Option.some({ id: projectId, title: `${projectId} title` } as never)),
    }),
  );
};

const commonLayers = Layer.mergeAll(
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  ServerSettings.layerTest(),
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
  NodeCrypto.layer,
  NodeServices.layer,
);

const toolkits = Layer.mergeAll(
  McpHttpServer.layerOrchestratorToolkit,
  McpHttpServer.layerProjectRegistration,
  McpHttpServer.layerThreadToolkit,
);

/**
 * A linked environment on its real `/mcp`, on a socket of its own. Calls
 * reaching it come through a link, so it never looks up a thread elsewhere,
 * and its own links list nothing, as the real service makes sure.
 */
const serveEnvironment = (
  descriptor: ExecutionEnvironmentDescriptor,
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
) =>
  Effect.gen(function* () {
    const sends = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const http = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
    const served = yield* servePeer(
      descriptor,
      toolkits.pipe(
        Layer.provide(environmentThreads(shells, sends)),
        Layer.provide(
          Layer.mock(PeerForwarding.PeerForwarding)({
            pinnedThreads: () => Effect.succeed({ threads: [], total: 0, unlisted: [] }),
          }),
        ),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), {
            prefix: `t3-peer-lookup-${descriptor.label}-`,
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
        Layer.provide(commonLayers),
      ),
    ).pipe(Effect.provideContext(http));
    return { ...served, sends };
  });

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "peer-lookup-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "peer-lookup-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** The laptop: its own threads, real forwarding over its links, and an agent calling tools. */
const makeLaptop = (shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
  Effect.gen(function* () {
    const sends = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
    const here = yield* Layer.build(
      toolkits.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(PeerForwarding.layer),
        Layer.provide(Layer.succeedContext(linking)),
        Layer.provide(
          environmentThreads(
            [
              liveThreadShell(agent),
              {
                ...liveThreadShell(fromDesk),
                linkOrigin: { sessionId: "session:desk", label: "T3 Code · Desk" },
              },
              ...shells,
            ],
            sends,
          ),
        ),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-lookup-laptop-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provide(commonLayers),
        Layer.fresh,
      ),
    );
    const server = Context.get(here, McpServer.McpServer);
    const call = (caller: ThreadId, name: string, args: Record<string, unknown>) =>
      server.callTool({ name, arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: laptop.environmentId,
          requestNamespace: `provider-session:${caller}`,
          thread: {
            threadId: caller,
            providerSessionId: `provider-session:${caller}`,
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
          issuedAt: 1,
        }),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    return { links: Context.get(linking, PeerLinks.PeerLinks), call, sends };
  });

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

it.effect("lists the pinned threads of every project, here and in each linked environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveEnvironment(box, [
        thread("thread:box-expert", "project:box", {
          pinned: true,
          updatedAt: "2026-10-03T00:00:00.000Z",
        }),
        thread("thread:box-plain", "project:box"),
      ]);
      const d = yield* serveEnvironment(desk, [thread("thread:desk-expert", "project:desk")]);
      const a = yield* makeLaptop([
        thread("thread:laptop-expert", "project:laptop", { pinned: true }),
        thread("thread:laptop-plain", "project:laptop"),
      ]);
      yield* linkTo(a.links, b, "full-access");
      yield* linkTo(a.links, d, "full-access");
      // The desk's address now answers as another environment: it is unreachable.
      yield* Ref.set(d.descriptor, descriptorOf("environment-elsewhere", "Elsewhere"));

      const listed = yield* a.call(agent, "t3_thread_list", { pinned: true });
      expect(listed.isError).toBe(false);
      expect(listed.structuredContent).toMatchObject({
        projectId: null,
        nextCursor: null,
        total: 2,
        threads: [
          {
            threadId: "thread:box-expert",
            projectId: "project:box",
            projectTitle: "project:box title",
            environmentId: box.environmentId,
            environmentLabel: "Box",
          },
          {
            threadId: "thread:laptop-expert",
            projectId: "project:laptop",
            projectTitle: "project:laptop title",
            environmentId: laptop.environmentId,
          },
        ],
        unlistedEnvironments: [
          { environmentId: desk.environmentId, label: "Desk", error: "Desk did not answer." },
        ],
      });
      const [, local] = (listed.structuredContent as { threads: ReadonlyArray<object> }).threads;
      expect(local).not.toHaveProperty("environmentLabel");

      // With a project, the filter applies to that project like any other.
      const inProject = (pinned: boolean) =>
        a
          .call(agent, "t3_thread_list", { projectId: "project:laptop", pinned })
          .pipe(
            Effect.map((result) =>
              (
                result.structuredContent as { threads: ReadonlyArray<{ threadId: string }> }
              ).threads.map(({ threadId }) => threadId),
            ),
          );
      expect(yield* inProject(true)).toEqual(["thread:laptop-expert"]);
      expect(yield* inProject(false)).toEqual(["thread:laptop-plain"]);

      // Work a link started here lists only what is here, and asks no link.
      yield* Ref.set(b.bearers, []);
      const relayed = yield* a.call(fromDesk, "t3_thread_list", { pinned: true });
      expect(relayed.structuredContent).toMatchObject({
        threads: [{ threadId: "thread:laptop-expert" }],
      });
      expect(relayed.structuredContent).not.toHaveProperty("unlistedEnvironments");
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ),
);

it.effect("finds a thread id without its environment wherever it is", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveEnvironment(box, [
        thread("thread:box-only", "project:box"),
        thread("thread:shared", "project:box"),
      ]);
      const d = yield* serveEnvironment(desk, [thread("thread:shared", "project:desk")]);
      const a = yield* makeLaptop([thread("thread:laptop-own", "project:laptop")]);
      yield* linkTo(a.links, b, "full-access");
      yield* linkTo(a.links, d, "full-access");

      // A local id stays here and asks no link.
      yield* Ref.set(b.bearers, []);
      const own = yield* a.call(agent, "t3_thread_read", { threadId: "thread:laptop-own" });
      expect(own.structuredContent).toMatchObject({ thread: { threadId: "thread:laptop-own" } });
      expect(yield* Ref.get(b.bearers)).toEqual([]);

      // An id only the box has reaches the box for reads, sends and waits.
      const read = yield* a.call(agent, "t3_thread_read", { threadId: "thread:box-only" });
      expect(read.structuredContent).toMatchObject({ thread: { threadId: "thread:box-only" } });
      const sent = yield* a.call(agent, "t3_thread_send", {
        threadId: "thread:box-only",
        message: "Over there.",
      });
      expect(sent.structuredContent).toMatchObject({
        threadId: "thread:box-only",
        delivery: "started",
      });
      expect(yield* Ref.get(b.sends)).toEqual(["thread:box-only"]);
      expect(yield* Ref.get(a.sends)).toEqual([]);
      const waited = yield* a.call(agent, "t3_thread_wait", { threadId: "thread:box-only" });
      expect(waited.structuredContent).toMatchObject({
        threadId: "thread:box-only",
        status: "completed",
      });

      // An id two linked environments have needs its environment.
      const ambiguous = yield* a.call(agent, "t3_thread_send", {
        threadId: "thread:shared",
        message: "Which one?",
      });
      expect(failureOf(ambiguous)).toMatchObject({ code: "invalid_request" });
      expect(failureOf(ambiguous).message).toContain(`Box (${box.environmentId})`);
      expect(failureOf(ambiguous).message).toContain(`Desk (${desk.environmentId})`);
      expect(yield* Ref.get(b.sends)).toEqual(["thread:box-only"]);
      expect(yield* Ref.get(d.sends)).toEqual([]);

      // An id nowhere is not found; a link that did not answer is named.
      const nowhere = yield* a.call(agent, "t3_thread_read", { threadId: "thread:nowhere" });
      expect(failureOf(nowhere)).toMatchObject({ code: "thread_not_found" });
      expect(failureOf(nowhere).message).not.toContain("did not answer");
      yield* Ref.set(d.descriptor, descriptorOf("environment-elsewhere", "Elsewhere"));
      const unanswered = yield* a.call(agent, "t3_thread_read", { threadId: "thread:nowhere" });
      expect(failureOf(unanswered)).toMatchObject({ code: "thread_not_found" });
      expect(failureOf(unanswered).message).toContain("Desk did not answer.");

      // Work a link started here never looks on this laptop's links.
      yield* Ref.set(b.bearers, []);
      const relayed = yield* a.call(fromDesk, "t3_thread_read", { threadId: "thread:box-only" });
      expect(failureOf(relayed)).toMatchObject({ code: "thread_not_found" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ),
);
