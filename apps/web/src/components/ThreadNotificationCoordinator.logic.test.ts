import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  TrimmedNonEmptyString,
  type OrchestrationV2RunOrigin,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
const visible: { archived: boolean; quiet: boolean; background?: boolean } = {
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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a completion when the thread resumes within the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    observe(working);
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the user's completion when a turn they didn't start begins within the grace", () => {
    const { notify, observe } = harness();
    const background = { ...visible, quiet: true, background: true };
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working, background);
    vi.advanceTimersByTime(500);
    observe(completed(2), background);
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("notifies a real completion once after the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies attention at once and replaces a pending completion", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-1:approval", settled: false, completedAt: null });
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    vi.advanceTimersByTime(60_000);
    // The request resolves and the same run reads as completed again.
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("notifies one completion across continuation gaps", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(2));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(3));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("keeps a completion interrupted by attention after a working gap from firing", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe({ attention: "run-1:approval", settled: false, completedAt: null });
    vi.advanceTimersByTime(60_000);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("adds nothing when attention follows a completion that already fired", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    observe({ attention: "run-1:limited", settled: false, completedAt: null });
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("still notifies a newer completion after attention", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-2:approval", settled: false, completedAt: null });
    observe(working);
    observe(completed(2));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("ignores unrelated updates while a completion waits", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies a run that settles again after a brief runtime blip", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("restarts the grace when a newer completion replaces a pending one", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe(completed(2));
    vi.advanceTimersByTime(1_500);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drops a pending completion on archive, stop request, removal or clear", () => {
    for (const end of [
      (h: ReturnType<typeof harness>) => h.observe(completed(1), { ...visible, archived: true }),
      (h: ReturnType<typeof harness>) =>
        h.observe({ ...completed(1) }, { ...visible, quiet: true }),
      (h: ReturnType<typeof harness>) => h.gate.retain(new Set()),
      (h: ReturnType<typeof harness>) => h.gate.clear(),
    ]) {
      const h = harness();
      h.observe(working);
      h.observe(completed(1));
      end(h);
      vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
      expect(h.notify).not.toHaveBeenCalled();
    }
  });

  it("never notifies a stopped run or the first observation", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
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
