import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderThreadId, RunId, ThreadId } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { AgentMemoryPressure } from "@t3tools/shared/AgentScope";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { ClaudeAgentSdkQueryRunnerError } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  AgentMemoryLimitError,
  atAgentMemoryLimit,
  retryWhileAgentsAtMemoryLimit,
} from "./agentMemoryLimit.ts";

const pressure = (highEvents: number, fullAvg10 = 0): AgentMemoryPressure => ({
  highEvents,
  fullAvg10,
});

// The query runner reports a registration timeout at the memory limit this way.
const memoryLimitFailure = () =>
  new ClaudeAgentSdkQueryRunnerError({
    method: "setMcpServers",
    cause: new AgentMemoryLimitError(),
  });

/** A start that fails `failures` times as given, then succeeds, and readings in order. */
const harness = Effect.fnUntraced(function* (input: {
  readonly failures: ReadonlyArray<ClaudeAgentSdkQueryRunnerError>;
  readonly readings: ReadonlyArray<AgentMemoryPressure>;
}) {
  const attempts = yield* Ref.make(0);
  const notices = yield* Ref.make(0);
  const reads = yield* Ref.make(0);
  const effect = retryWhileAgentsAtMemoryLimit({
    start: Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
      Effect.flatMap((attempt) => {
        const failure = input.failures[attempt];
        return failure === undefined ? Effect.succeed("started") : Effect.fail(failure);
      }),
    ),
    readPressure: Ref.getAndUpdate(reads, (count) => count + 1).pipe(
      Effect.map((read) => input.readings[Math.min(read, input.readings.length - 1)]),
    ),
    onWait: Ref.update(notices, (count) => count + 1),
  });
  return { effect, attempts, notices };
});

describe("atAgentMemoryLimit", () => {
  it("counts new throttling or heavy stalling as the limit", () => {
    assert.isTrue(atAgentMemoryLimit(pressure(10), pressure(11)));
    assert.isTrue(atAgentMemoryLimit(pressure(10), pressure(10, 40)));
    assert.isFalse(atAgentMemoryLimit(pressure(10), pressure(10, 2)));
    // A count without an earlier one cannot show throttling during the start.
    assert.isFalse(atAgentMemoryLimit(undefined, pressure(500, 2)));
    // Without a slice there is no shared limit.
    assert.isFalse(atAgentMemoryLimit(pressure(10), undefined));
  });
});

describe("retryWhileAgentsAtMemoryLimit", () => {
  it.effect("starts again once the pressure drops and notes the wait once", () =>
    Effect.gen(function* () {
      const { effect, attempts, notices } = yield* harness({
        failures: [memoryLimitFailure(), memoryLimitFailure()],
        // Throttled until the third reading, calm after that.
        readings: [pressure(100), pressure(200, 35), pressure(200), pressure(200)],
      });
      const fiber = yield* Effect.forkChild(effect);
      yield* TestClock.adjust("1 minute");
      assert.equal(yield* Fiber.join(fiber), "started");
      assert.equal(yield* Ref.get(attempts), 3);
      assert.equal(yield* Ref.get(notices), 1);
    }),
  );

  it.effect("fails with the memory limit when the pressure stays for five minutes", () =>
    Effect.gen(function* () {
      const failure = memoryLimitFailure();
      const { effect, attempts } = yield* harness({
        failures: [failure],
        readings: [pressure(100, 40)],
      });
      const fiber = yield* Effect.forkChild(effect);
      yield* TestClock.adjust("4 minutes");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(yield* Effect.flip(Fiber.join(fiber)), failure);
      assert.equal(yield* Ref.get(attempts), 1);
    }),
  );

  it.effect("fails other start errors at once", () =>
    Effect.gen(function* () {
      const failure = new ClaudeAgentSdkQueryRunnerError({
        method: "setMcpServers",
        cause: "Claude Code did not answer the MCP server registration.",
      });
      const { effect, attempts, notices } = yield* harness({
        failures: [failure],
        readings: [pressure(100, 40)],
      });
      assert.strictEqual(yield* Effect.flip(effect), failure);
      assert.equal(yield* Ref.get(attempts), 1);
      assert.equal(yield* Ref.get(notices), 0);
    }),
  );

  it.effect("stops waiting when the run is stopped", () =>
    Effect.gen(function* () {
      const { effect, attempts } = yield* harness({
        failures: [memoryLimitFailure()],
        readings: [pressure(100, 40)],
      });
      const fiber = yield* Effect.forkChild(effect);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust("10 minutes");
      assert.equal(yield* Ref.get(attempts), 1);
    }),
  );
});

it("tells the user why a turn that gave up could not start", () => {
  const cause = new ProviderAdapter.ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("claudeAgent"),
    threadId: ThreadId.make("thread:memory-limit"),
    providerThreadId: ProviderThreadId.make("provider-thread:memory-limit"),
    runId: RunId.make("run:memory-limit"),
    cause: memoryLimitFailure(),
  });
  assert.equal(
    makeProviderFailure({ cause: Cause.fail(cause) }).message,
    new AgentMemoryLimitError().message,
  );
});
