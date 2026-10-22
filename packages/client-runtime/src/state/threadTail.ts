import { OrchestrationV2ThreadTail, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { THREAD_TAIL_DEFAULT_MESSAGES, threadTailFromRows } from "@t3tools/shared/threadTail";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import type { Atom } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { fetchEnvironmentBoundedThreadSnapshot } from "./boundedThreadSnapshotHttp.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";
import { EnvironmentHttpConnectionNotReadyError } from "./pullRequests.ts";
import { persistQuery } from "./queryPersistence.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

const DEFAULT_THREAD_TAIL_TIMEOUT_MS = 6_000;

const fetchEnvironmentThreadTail = Effect.fn("clientRuntime.state.fetchEnvironmentThreadTail")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly threadId: ThreadId;
    readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization?: Option.Option<
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
    >;
    readonly timeoutMs?: number;
  }) {
    const endpoint = { params: { threadId: input.threadId }, query: {} };
    // A server from before the tail route answers 404, or its app page; its bounded snapshot
    // holds the same messages.
    const fromBoundedSnapshot = fetchEnvironmentBoundedThreadSnapshot(input).pipe(
      Effect.map((snapshot) => ({
        messages: threadTailFromRows(
          snapshot.projection.visibleTurnItems,
          THREAD_TAIL_DEFAULT_MESSAGES,
        ),
      })),
    );
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "orchestration",
      method: "GET",
      url: (urls) => urls.threadTail(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_TAIL_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.threadTail({ ...endpoint, headers: withOrchestrationProtocolHeader(headers) }),
    }).pipe(
      Effect.catchTags({
        RemoteEnvironmentAuthInvalidJsonError: () => fromBoundedSnapshot,
        RemoteEnvironmentAuthUndeclaredStatusError: (error) =>
          error.status === 404 ? fromBoundedSnapshot : Effect.fail(error),
      }),
    );
  },
);

type ThreadTailFetch = ReturnType<typeof fetchEnvironmentThreadTail>;

export class ThreadTailLoader extends Context.Service<
  ThreadTailLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<Effect.Success<ThreadTailFetch>, Effect.Error<ThreadTailFetch>>;
  }
>()("@t3tools/client-runtime/state/threadTail/ThreadTailLoader") {}

export const layer: Layer.Layer<ThreadTailLoader, never, HttpClient.HttpClient> = Layer.effect(
  ThreadTailLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return ThreadTailLoader.of({
      load: (prepared, threadId) =>
        fetchEnvironmentThreadTail({ prepared, threadId, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);

export interface ThreadTailTarget {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly threadId: ThreadId };
}

/**
 * Each thread's tail, read over HTTP. It reloads only when `refreshTrigger` changes, so a
 * reader decides which thread changes are worth a request.
 */
export function createThreadTailAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ThreadTailLoader | R, E>,
  options: { readonly refreshTrigger: (target: ThreadTailTarget) => Atom.Atom<unknown> },
) {
  const load = Effect.fn("ThreadTail.load")(function* (input: ThreadTailTarget["input"]) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const loader = yield* ThreadTailLoader;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return yield* new EnvironmentHttpConnectionNotReadyError({
        message: "The environment HTTP connection is not ready.",
      });
    }
    return yield* loader.load(prepared.value, input.threadId);
  });
  return createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:thread-tail",
    persistence: persistQuery(OrchestrationV2ThreadTail),
    // Changes arrive through the trigger; this only bounds how stale a reopened tail may be.
    staleTimeMs: 5 * 60_000,
    execute: load,
    refreshTrigger: options.refreshTrigger,
  });
}
