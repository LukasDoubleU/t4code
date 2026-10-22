import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpEnvironmentLinksResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  type OrchestratorMcpUnlistedEnvironment,
  type PeerLinkSummary,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";

import { assertNotLinked, callerLinkOrigin } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { readCaller, receivedMessage, unavailable } from "../mcp/threadAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/**
 * A peer's `/mcp` holds a wait open for its whole timeout without sending
 * anything, and T3 Connect's edge drops a request idle for about 100 s, so a
 * forwarded wait goes out in pieces no longer than this.
 */
export const FORWARDED_WAIT_CHUNK_MS = 50_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;

type Scope = McpInvocationContext.McpInvocationScope;

/**
 * Runs T3 MCP tools in a linked environment for an agent here. The tool's own
 * declaration checks the agent here first; the linked environment then holds
 * the call to the link's access, narrowed to the agent's modes, which every
 * forwarded call carries.
 */
export class PeerForwarding extends Context.Service<
  PeerForwarding,
  {
    /**
     * Runs `tool` in the linked environment `environmentId` with `params`. A
     * `t3_thread_wait` goes in pieces short enough to survive any route.
     */
    readonly call: <T extends Tool.Any>(
      scope: Scope,
      tool: T,
      environmentId: EnvironmentId,
      params: Tool.Parameters<T>,
    ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
    /** `t3_thread_read` there. */
    readonly readThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    /** `t3_thread_interrupt` there. */
    readonly interruptThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadInterruptInput,
    ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
    /**
     * `t3_thread_wait` there, in pieces short enough to survive any route.
     * Unlike `call`, a message for the caller's thread does not end it.
     */
    readonly waitForThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadWaitInput,
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
    /** The environments this one links to, as an agent sees them. */
    readonly links: (
      scope: Scope,
    ) => Effect.Effect<OrchestratorMcpEnvironmentLinksResult, OrchestratorMcpFailure>;
    /**
     * `t3_thread_list` of every project's pinned threads in each linked
     * environment, and the ones that could not list theirs.
     */
    readonly pinnedThreads: (
      scope: Scope,
      input: OrchestratorMcpThreadListInput,
    ) => Effect.Effect<
      {
        readonly threads: ReadonlyArray<OrchestratorMcpThreadListItem>;
        readonly total: number;
        readonly unlisted: ReadonlyArray<OrchestratorMcpUnlistedEnvironment>;
      },
      OrchestratorMcpFailure
    >;
    /**
     * The one linked environment that has a thread this environment does not,
     * or nothing when none that answered has it. Several having it is an error.
     */
    readonly locateThread: (
      scope: Scope,
      threadId: ThreadId,
    ) => Effect.Effect<EnvironmentId | undefined, OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerForwarding") {}

/** The linked environment a call names, or nothing when it names this one. */
export const remoteTarget = (scope: Scope, environmentId: EnvironmentId | undefined) =>
  environmentId === scope.environmentId ? undefined : environmentId;

const make = Effect.gen(function* () {
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagement.ThreadManagementService;

  /**
   * The caller's own limits here, which travel with every call it forwards.
   * The peer sees only the link's credential, so a credential that may not
   * control threads here is refused here. Work a link started here never uses
   * this environment's own links: the peer would see this environment's
   * session, not the link the work came from, so its fence could not hold.
   */
  const callerLimits = (scope: Scope) =>
    readCaller().pipe(
      Effect.tap((caller) => assertNotLinked(caller, "use this environment's links")),
      Effect.map((caller) => caller.limits),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  /**
   * Every caller here reaches the peer as the one link session, so a retry
   * key is scoped to its caller before it leaves: two agents here reusing a
   * key never collide there, and one agent retrying gets its first result.
   */
  const scopedRequestId = (namespace: string, clientRequestId: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(`${namespace}\n${clientRequestId}`)).pipe(
      Effect.map((digest) => `fwd:${Hex.encode(digest)}`),
      Effect.orDie,
    );

  /** Tool and contract schemas are plain data: they encode and decode without services. */
  const forward = Effect.fn("PeerForwarding.forward")(function* <A>(
    scope: Scope,
    toolName: string,
    parameters: Schema.Top,
    success: Schema.Top,
    environmentId: EnvironmentId,
    params: unknown,
  ) {
    const limits = yield* callerLimits(scope);
    const encoded = (yield* Schema.encodeUnknownEffect(parameters as Schema.Encoder<unknown>)(
      params,
    ).pipe(Effect.mapError(unavailable))) as Record<string, unknown>;
    const { environmentId: _target, ...args } = encoded;
    // A pending upload lives here, so it cannot go with the call.
    if (Array.isArray(args.attachments) && args.attachments.length > 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A launch in a linked environment cannot carry attachments yet.",
      });
    }
    if (typeof args.clientRequestId === "string") {
      args.clientRequestId = yield* scopedRequestId(scope.requestNamespace, args.clientRequestId);
    }
    return yield* peers.call({
      environmentId,
      tool: toolName,
      arguments: args,
      limits,
      success: success as Schema.Decoder<A>,
    });
  });

  const readThread: PeerForwarding["Service"]["readThread"] = (scope, environmentId, input) =>
    forward<OrchestratorMcpThreadReadResult>(
      scope,
      "t3_thread_read",
      OrchestratorMcpThreadReadInput,
      OrchestratorMcpThreadReadResult,
      environmentId,
      input,
    );

  const interruptThread: PeerForwarding["Service"]["interruptThread"] = (
    scope,
    environmentId,
    input,
  ) =>
    forward<OrchestratorMcpThreadInterruptResult>(
      scope,
      "t3_thread_interrupt",
      OrchestratorMcpThreadInterruptInput,
      OrchestratorMcpThreadInterruptResult,
      environmentId,
      input,
    );

  const waitForThread: PeerForwarding["Service"]["waitForThread"] = Effect.fn(
    "PeerForwarding.waitForThread",
  )(function* (scope, environmentId, input) {
    let remaining = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    let runId = input.runId;
    while (true) {
      const chunk = Math.min(remaining, FORWARDED_WAIT_CHUNK_MS);
      const result = yield* forward<OrchestratorMcpThreadWaitResult>(
        scope,
        "t3_thread_wait",
        OrchestratorMcpThreadWaitInput,
        OrchestratorMcpThreadWaitResult,
        environmentId,
        {
          threadId: input.threadId,
          ...(runId === undefined ? {} : { runId }),
          timeoutMs: chunk,
          ...(input.untilDelegatedWorkSettled === undefined
            ? {}
            : { untilDelegatedWorkSettled: input.untilDelegatedWorkSettled }),
        },
      );
      remaining -= chunk;
      if (!result.timedOut || remaining <= 0) return result;
      // Later pieces wait for the run the first one picked, not a newer one.
      runId = result.runId ?? undefined;
    }
  });

  /**
   * An agent's own `t3_thread_wait` blocks its turn here, so a message for its
   * thread ends the wait here, whatever the run there does. The run there is
   * read once more for its state then.
   */
  const waitAsCaller = Effect.fn("PeerForwarding.waitAsCaller")(function* (
    scope: Scope,
    environmentId: EnvironmentId,
    input: OrchestratorMcpThreadWaitInput,
  ) {
    const settles = waitForThread(scope, environmentId, input);
    if (scope.thread === undefined) return yield* settles;
    const woken = threads.awaitIncomingMessage(scope.thread.threadId).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((incoming) =>
        Effect.all(
          [
            waitForThread(scope, environmentId, { ...input, timeoutMs: 1 }),
            receivedMessage(threads, incoming),
          ],
          { concurrency: 2 },
        ),
      ),
      Effect.map(([result, messageReceived]) => ({ ...result, timedOut: false, messageReceived })),
    );
    return yield* Effect.raceFirst(settles, woken);
  });

  const call: PeerForwarding["Service"]["call"] = (scope, tool, environmentId, params) =>
    tool.name === "t3_thread_wait"
      ? (waitAsCaller(
          scope,
          environmentId,
          params as OrchestratorMcpThreadWaitInput,
        ) as Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure>)
      : forward(scope, tool.name, tool.parametersSchema, tool.successSchema, environmentId, params);

  /**
   * The next step for an agent whose machine is not linked: without it, an
   * empty list reads as a dead end and agents go looking elsewhere.
   */
  const NOT_LISTED =
    "A machine the user means that is not listed here is not linked yet: ask the user to link it in Settings → Connections.";

  const listLinks: PeerForwarding["Service"]["links"] = Effect.fn("PeerForwarding.listLinks")(
    function* (scope) {
      yield* callerLimits(scope);
      const listed = yield* links.list.pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
      return {
        environmentId: scope.environmentId,
        links: listed.map((link) => ({
          environmentId: link.environmentId,
          label: link.label,
          status: link.status,
          access: link.access,
          expiresAt: DateTime.formatIso(link.expiresAt),
          lastError: link.lastError,
        })),
        notListed: NOT_LISTED,
      };
    },
  );

  /**
   * A call that came through a link never asks this environment's links in
   * turn, whatever the link's access: two environments linked to each other
   * would ask each other forever.
   */
  const asksLinks = (scope: Scope) =>
    readCaller().pipe(
      Effect.map((caller) => callerLinkOrigin(caller) === undefined),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  const unanswered = (link: PeerLinkSummary): OrchestratorMcpUnlistedEnvironment => ({
    environmentId: link.environmentId,
    label: link.label,
    error:
      link.status === "expired"
        ? `The link to ${link.label} expired. Link it again with a new pairing code from ${link.label}.`
        : `${link.label} did not answer.`,
  });

  /** The links that answer now, and why each other one is left out. */
  const answeringLinks = links.list.pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
    ),
    Effect.map((listed) => ({
      answering: listed.filter((link) => link.status === "reachable"),
      silent: listed.filter((link) => link.status !== "reachable").map(unanswered),
    })),
  );

  const pinnedThreads: PeerForwarding["Service"]["pinnedThreads"] = Effect.fn(
    "PeerForwarding.pinnedThreads",
  )(function* (scope, input) {
    if (!(yield* asksLinks(scope))) return { threads: [], total: 0, unlisted: [] };
    const { answering, silent } = yield* answeringLinks;
    const { cursor: _cursor, ...rest } = input;
    // A linked environment on an older build still lists children that copied
    // their parent's pin, unless it is told to leave children out.
    const listing = { ...rest, includeSubagents: false };
    const listed = yield* Effect.forEach(
      answering,
      (link) =>
        forward<OrchestratorMcpThreadListResult>(
          scope,
          "t3_thread_list",
          OrchestratorMcpThreadListInput,
          OrchestratorMcpThreadListResult,
          link.environmentId,
          listing,
        ).pipe(
          Effect.result,
          Effect.map((result) => ({ link, result })),
        ),
      { concurrency: "unbounded" },
    );
    return {
      threads: listed.flatMap(({ link, result }) =>
        Result.isSuccess(result)
          ? result.success.threads.map((thread) => ({
              ...thread,
              environmentId: link.environmentId,
              environmentLabel: link.label,
            }))
          : [],
      ),
      total: listed.reduce(
        (sum, { result }) => sum + (Result.isSuccess(result) ? result.success.total : 0),
        0,
      ),
      unlisted: [
        ...silent,
        ...listed.flatMap(({ link, result }) =>
          Result.isFailure(result)
            ? [
                {
                  environmentId: link.environmentId,
                  label: link.label,
                  error: result.failure.message,
                },
              ]
            : [],
        ),
      ],
    };
  });

  const locateThread: PeerForwarding["Service"]["locateThread"] = Effect.fn(
    "PeerForwarding.locateThread",
  )(function* (scope, threadId) {
    // A caller that may not ask the links hears that the thread is not here.
    if (!(yield* asksLinks(scope).pipe(Effect.orElseSucceed(() => false)))) return undefined;
    const { answering, silent } = yield* answeringLinks;
    // The smallest read there: only whether the thread exists matters.
    const probed = yield* Effect.forEach(
      answering,
      (link) =>
        readThread(scope, link.environmentId, {
          threadId,
          limit: 1,
          runLimit: 1,
          maxCharsPerItem: 1,
        }).pipe(
          Effect.result,
          Effect.map((result) => ({ link, result })),
        ),
      { concurrency: "unbounded" },
    );
    const holders = probed.flatMap(({ link, result }) => (Result.isSuccess(result) ? [link] : []));
    const [holder, ...others] = holders;
    if (holder !== undefined && others.length === 0) return holder.environmentId;
    if (holder !== undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Thread ${threadId} is in several linked environments: ${holders
          .map((link) => `${link.label} (${link.environmentId})`)
          .join(", ")}. Pass environmentId to pick one.`,
      });
    }
    const unchecked = [
      ...silent,
      ...probed.flatMap(({ link, result }) =>
        Result.isFailure(result) && result.failure.code !== "thread_not_found"
          ? [{ error: `${link.label}: ${result.failure.message}` }]
          : [],
      ),
    ];
    if (unchecked.length === 0) return undefined;
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: `Thread ${threadId} is neither here nor in a linked environment that answered. ${unchecked
        .map((environment) => environment.error)
        .join(" ")}`,
    });
  });

  return PeerForwarding.of({
    call,
    readThread,
    interruptThread,
    waitForThread,
    links: listLinks,
    pinnedThreads,
    locateThread,
  });
});

export const layer = Layer.effect(PeerForwarding, make);
