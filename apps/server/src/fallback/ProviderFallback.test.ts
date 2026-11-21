import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderFallbackEntry,
  RunAttemptId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  BUDGET_FAILURE_CODE,
  cutOffNote,
  nextMonthStart,
  REFUSED_FAILURE_CODE,
} from "./fallbackChain.ts";
import { NO_LIMIT } from "./openRouterKey.ts";
import * as ProviderFallback from "./ProviderFallback.ts";
import * as ProviderFallbackReactor from "./ProviderFallbackReactor.ts";
import * as ProviderFallbackStore from "./ProviderFallbackStore.ts";

const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const geminiKey = {
  instanceId: ProviderInstanceId.make("antigravity_api"),
  model: "gemini-3-pro",
  budget: { monthlyUsd: 1, perRunUsd: 0.6 },
} satisfies ProviderFallbackEntry;
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const openRouter = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "openrouter/anthropic/claude-sonnet-4.5",
  budget: { monthlyUsd: 20, perRunUsd: 2 },
} satisfies ProviderFallbackEntry;

const provider = (instanceId: ProviderInstanceId, driver: string): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  displayName: instanceId,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "1970-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

/** Commands the reactor sent, read by the tests that share one layer. */
class Dispatched extends Context.Service<Dispatched, Array<OrchestrationV2ServerCommand>>()(
  "t3/fallback/ProviderFallback.test/Dispatched",
) {}

/** OpenRouter answers the key check with `limit`; the chain is antigravity_api, codex, opencode. */
const layer = (limit: number | null, dispatched: Array<OrchestrationV2ServerCommand> = []) =>
  ProviderFallbackReactor.layer.pipe(
    Layer.provideMerge(Layer.succeed(Dispatched, dispatched)),
    Layer.provideMerge(ProviderFallback.layer),
    Layer.provide(ProviderFallbackStore.layer),
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([
          provider(geminiKey.instanceId, "antigravity"),
          provider(codex.instanceId, "codex"),
          provider(openRouter.instanceId, "opencode"),
        ]),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [geminiKey.instanceId]: { driver: "antigravity", enabled: true },
          [codex.instanceId]: { driver: "codex", enabled: true },
          [openRouter.instanceId]: {
            driver: "opencode",
            enabled: true,
            environment: [{ name: "OPENROUTER_API_KEY", value: "sk-or-demo", sensitive: true }],
          },
        },
        providerFallbackChain: [geminiKey, codex, openRouter],
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ data: { limit, limit_remaining: limit } }), {
                status: request.headers.authorization === "Bearer sk-or-demo" ? 200 : 401,
              }),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 0, storedEvents: [] };
          }),
      }),
    ),
    Layer.provide(Layer.mock(EventSink.EventSinkV2)({})),
    Layer.provide(NodeServices.layer),
  );

const policy = Effect.gen(function* () {
  const value = yield* ProviderFallback.ProviderFallbackPolicy;
  if (value === null) return yield* Effect.die("no fallback policy");
  return value;
});

const reserve = (runId: string, selection: ModelSelection = geminiKey) =>
  Effect.flatMap(policy, (fallback) =>
    fallback.reserveTurn({ threadId, projectId, runId: RunId.make(runId), selection }),
  );

it.layer(layer(25))("a fallback chain with budgets", (it) => {
  it.effect("reserves each run's cap before it starts and refuses a run the month cannot pay", () =>
    Effect.gen(function* () {
      const fallback = yield* policy;
      assert.isNull(yield* reserve("run-1"));
      assert.isNull(yield* reserve("run-2"), "the 0.4 left still covers a run, capped at 0.4");
      assert.equal((yield* fallback.reservation(RunId.make("run-2")))?.capUsd.toFixed(2), "0.40");
      const refused = yield* reserve("run-3");
      assert.deepInclude(refused, {
        class: "usage_limit",
        quota: "exhausted",
        code: BUDGET_FAILURE_CODE,
        resetAt: DateTime.formatIso(DateTime.makeUnsafe(nextMonthStart(0))),
      });
      // An entry without a budget never reserves.
      assert.isNull(yield* reserve("run-4", codex));

      // A new turn on the spent entry starts on the next ready one instead.
      assert.deepStrictEqual(yield* fallback.turnStart({ projectId, selection: geminiKey }), {
        selection: codex,
        from: "antigravity_api (gemini-3-pro)",
        to: "codex (gpt-5.4)",
      });
      const status = yield* fallback.status(projectId);
      assert.deepInclude(status.entries[0], { state: "budget" });
      assert.deepInclude(status.entries[0]?.budget, { spentUsd: 0, reservedUsd: 1 });
      assert.deepInclude(status.entries[2], { state: "ready" });
    }),
  );

  it.effect("interrupts a run at its cap, then settles what it cost", () =>
    Effect.gen(function* () {
      const fallback = yield* policy;
      const reactor = yield* ProviderFallbackReactor.ProviderFallbackReactor;
      const dispatched = yield* Dispatched;
      const runId = RunId.make("open-router-run");
      assert.isNull(yield* reserve(runId, openRouter));
      const now = yield* DateTime.now;
      const run = {
        id: runId,
        threadId,
        status: "running",
        modelSelection: openRouter,
        providerInstanceId: openRouter.instanceId,
        userMessageId: MessageId.make("message"),
      } as unknown as OrchestrationV2Run;
      const runEvent = (status: OrchestrationV2Run["status"]): OrchestrationV2DomainEvent => ({
        id: EventId.make(`run:${status}`),
        type: "run.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: { ...run, status },
      });
      const usage = (costUsd: number): OrchestrationV2DomainEvent =>
        ({
          id: EventId.make(`usage:${costUsd}`),
          type: "provider-turn.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: "provider-turn",
            runAttemptId: RunAttemptId.make("attempt"),
            status: "running",
            turnTokenUsage: {
              usageScope: "main_agent",
              hasSubagents: false,
              usageStatus: "partial",
              reportedCostUsd: costUsd,
            },
          },
        }) as unknown as OrchestrationV2DomainEvent;

      yield* reactor.handle(runEvent("running"));
      yield* reactor.handle(usage(1.2));
      assert.lengthOf(dispatched, 0);
      yield* reactor.handle(usage(2.05));
      assert.deepInclude(dispatched[0], {
        type: "run.interrupt",
        commandId: CommandId.make(`server:provider-fallback:budget-stop:${runId}`),
        runId,
      });
      assert.isNotNull((yield* fallback.reservation(runId))?.stoppedAt ?? null);
      // Further usage after the stop does not interrupt again.
      yield* reactor.handle(usage(2.4));
      assert.lengthOf(dispatched, 1);
    }),
  );
});

it.layer(layer(25))("a turn moved to another driver", (it) => {
  it.effect("first reads where its previous attempt was cut off", () =>
    Effect.gen(function* () {
      const fallback = yield* policy;
      assert.equal(
        yield* fallback.continuationNote({ from: geminiKey, to: codex }),
        cutOffNote("antigravity_api (gemini-3-pro)"),
      );
      // Another account of the same driver resumes its native session without a note.
      assert.isNull(yield* fallback.continuationNote({ from: codex, to: codex }));
    }),
  );
});

it.layer(layer(null))("an OpenRouter entry", (it) => {
  it.effect("is refused while its key has no credit limit", () =>
    Effect.gen(function* () {
      const fallback = yield* policy;
      const status = yield* fallback.status(projectId);
      assert.deepInclude(status.entries[2], { state: "refused", reason: NO_LIMIT });
      // A thread already on the entry does not start a turn on the key either.
      assert.deepInclude(yield* reserve("refused-run", openRouter), {
        quota: "exhausted",
        code: REFUSED_FAILURE_CODE,
        message: NO_LIMIT,
      });
    }),
  );
});
