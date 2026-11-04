import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  TrimmedNonEmptyString,
  type OrchestrationV2RunOrigin,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import {
  createThreadNotificationGate,
  observeThreadNotification,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  settled: false,
  completedAt: null,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
  settled: true,
  completedAt: at,
});
const visible: { archived: boolean; quiet: boolean } = {
  archived: false,
  quiet: false,
};

function harness() {
  const notify = vi.fn();
  const gate = createThreadNotificationGate<string>(notify);
  let prior: ThreadNotificationObservation | undefined;
  const observe = (next: ThreadNotificationObservation, options = visible) => {
    gate.observe("thread", prior, next, options);
    prior = next;
  };
  return { gate, notify, observe };
}

describe("createThreadNotificationGate", () => {
  it("notifies a completion immediately and only once", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    observe(working);
    observe(completed(1));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies each newer completion immediately", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    observe(working);
    observe(completed(2));
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "completion"],
    ]);
    observe(completed(1));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("notifies attention once and still notifies the subsequent completion", () => {
    const { notify, observe } = harness();
    observe(working);
    const attention = { attention: "run-1:approval", settled: false, completedAt: null };
    observe(attention);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    observe({ ...attention });
    expect(notify).toHaveBeenCalledTimes(1);
    observe(working);
    observe(completed(1));
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("lets Needs you replace the completion it arrives with", () => {
    const { notify, observe } = harness();
    observe(working);
    const needsYou = { attention: "attention:1", settled: true, completedAt: 1 };
    observe(needsYou);
    observe({ ...needsYou });
    observe(completed(1));
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("does not replay a completion after attention resolves", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    observe({ attention: "run-1:limited", settled: false, completedAt: null });
    observe(completed(1));
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("never notifies existing, archived or stopped completions, including when unarchived", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    observe(completed(2));
    observe(working);
    observe(completed(3), { ...visible, archived: true });
    observe(completed(3));
    expect(notify).not.toHaveBeenCalled();
    observe(working);
    observe(completed(4));
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("forgets handled completions when a thread is removed or the gate is cleared", () => {
    for (const reset of [
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.retain(new Set()),
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.clear(),
    ]) {
      const { gate, notify, observe } = harness();
      observe(completed(1));
      reset(gate);
      gate.observe("thread", undefined, working, visible);
      gate.observe("thread", working, completed(1), visible);
      expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    }
  });
});

const environmentId = EnvironmentId.make("environment-test");
const endedAt = DateTime.makeUnsafe("2026-10-22T10:00:00.000Z");

function endedTurn(input: {
  readonly status: "completed" | "failed" | "running";
  readonly origin?: OrchestrationV2RunOrigin;
  readonly asks?: boolean;
  readonly attention?: { readonly reason: string; readonly requestedAt: DateTime.Utc };
}) {
  return presentThreadShell(environmentId, {
    ...makeThreadFixture().source,
    latestRunId: RunId.make("run-1"),
    status: input.status,
    latestRunCompletedAt: input.status === "running" ? null : endedAt,
    ...(input.origin === undefined ? {} : { latestRunOrigin: input.origin }),
    pendingRuntimeRequest: input.asks
      ? { id: RuntimeRequestId.make("request-1"), kind: "user_input", createdAt: endedAt }
      : null,
    attention:
      input.attention === undefined
        ? null
        : { ...input.attention, reason: TrimmedNonEmptyString.make(input.attention.reason) },
  });
}

describe("observeThreadNotification", () => {
  it.each([undefined, "user"] as const)(
    "lets a completed turn the user started notify (%s)",
    (origin) => {
      expect(
        observeThreadNotification(
          endedTurn({ status: "completed", ...(origin === undefined ? {} : { origin }) }),
        ),
      ).toMatchObject({ settled: true, quiet: false, attention: null });
    },
  );

  it.each(["agent", "schedule", "wake"] as const)(
    "keeps the completion of a %s turn quiet",
    (origin) => {
      expect(observeThreadNotification(endedTurn({ status: "completed", origin }))).toMatchObject({
        settled: true,
        quiet: true,
      });
    },
  );

  it("still reports a failure or a question from a turn the user did not start", () => {
    expect(
      observeThreadNotification(endedTurn({ status: "failed", origin: "agent" })),
    ).toMatchObject({ status: "failed", attention: "run-1:failed", needsYou: false });
    expect(
      observeThreadNotification(endedTurn({ status: "completed", origin: "schedule", asks: true })),
    ).toMatchObject({ status: "input", attention: "run-1:input", needsYou: false });
  });

  it("keys an agent's call for the user by when it asked, while it works or after", () => {
    const attention = { reason: "Pick a release date", requestedAt: endedAt };
    const working = observeThreadNotification(
      endedTurn({ status: "running", origin: "agent", attention }),
    );
    expect(working).toMatchObject({ needsYou: true });
    expect(working.attention).not.toBeNull();
    const done = observeThreadNotification(
      endedTurn({ status: "completed", origin: "agent", attention }),
    );
    expect(done.attention).toBe(working.attention);
    const again = observeThreadNotification(
      endedTurn({
        status: "completed",
        origin: "agent",
        attention: { ...attention, requestedAt: DateTime.add(endedAt, { minutes: 5 }) },
      }),
    );
    expect(again.attention).not.toBe(working.attention);
  });
});
