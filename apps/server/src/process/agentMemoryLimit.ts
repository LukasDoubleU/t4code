import type { AgentMemoryPressure, AgentScopeShape } from "@t3tools/shared/AgentScope";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const AGENT_MEMORY_LIMIT_NOTICE =
  "Agents are at their memory limit; this turn starts when memory frees up.";

// The kernel throttles agents over MemoryHigh instead of failing them, so a
// start that times out while they stall this much is waiting for memory.
const FULL_PRESSURE_PERCENT = 10;
const MEMORY_LIMIT_WAIT_MS = 5 * 60_000;
const MEMORY_POLL_INTERVAL = "5 seconds";

export class AgentMemoryLimitError extends Schema.TaggedError<AgentMemoryLimitError>()(
  "AgentMemoryLimitError",
  {},
) {
  override get message(): string {
    return "Agents stayed at their memory limit, so this turn could not start. Send it again once memory frees up.";
  }
}

export const agentMemoryPressure = (
  scope: AgentScopeShape,
): Effect.Effect<AgentMemoryPressure | undefined> => scope.memoryPressure ?? Effect.undefined;

/** Agents were throttled at their limit since `before`, or stall on memory now. */
export function atAgentMemoryLimit(
  before: AgentMemoryPressure | undefined,
  after: AgentMemoryPressure | undefined,
): boolean {
  if (after === undefined) return false;
  return (
    (before !== undefined && after.highEvents > before.highEvents) ||
    after.fullAvg10 >= FULL_PRESSURE_PERCENT
  );
}

const isAgentMemoryLimitError = Schema.is(AgentMemoryLimitError);

function causedByAgentMemoryLimit(error: unknown): boolean {
  for (let depth = 0; depth < 8 && typeof error === "object" && error !== null; depth++) {
    if (isAgentMemoryLimitError(error)) return true;
    error = (error as { readonly cause?: unknown }).cause;
  }
  return false;
}

/** Whether the pressure dropped before `giveUpAt`: no new throttling and little stalling. */
const waitForAgentMemory = Effect.fn("AgentMemoryLimit.waitForAgentMemory")(function* (
  readPressure: Effect.Effect<AgentMemoryPressure | undefined>,
  giveUpAt: number,
) {
  let previous = yield* readPressure;
  while ((yield* Clock.currentTimeMillis) < giveUpAt) {
    yield* Effect.sleep(MEMORY_POLL_INTERVAL);
    const current = yield* readPressure;
    if (!atAgentMemoryLimit(previous, current)) return true;
    previous = current;
  }
  return false;
});

/**
 * Runs `start` again each time it fails because agents are at their memory
 * limit, once the pressure drops, for a few minutes at most. `onWait` runs when
 * the first such failure starts the wait. Interrupting the effect stops waiting.
 */
export const retryWhileAgentsAtMemoryLimit = <A, E, R>(input: {
  readonly start: Effect.Effect<A, E, R>;
  readonly readPressure: Effect.Effect<AgentMemoryPressure | undefined>;
  readonly onWait: Effect.Effect<void, never, R>;
}): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let giveUpAt: number | undefined;
    const attempt: Effect.Effect<A, E, R> = input.start.pipe(
      Effect.catchIf(causedByAgentMemoryLimit, (error) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (giveUpAt === undefined) {
            giveUpAt = now + MEMORY_LIMIT_WAIT_MS;
            yield* input.onWait;
          }
          if (!(yield* waitForAgentMemory(input.readPressure, giveUpAt))) {
            return yield* Effect.fail(error);
          }
          return yield* attempt;
        }),
      ),
    );
    return attempt;
  });
