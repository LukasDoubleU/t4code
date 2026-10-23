import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  TrimmedNonEmptyString,
  type OrchestrationV2RunOrigin,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import { decideThreadNotification } from "./ThreadNotificationCoordinator.logic";

const environmentId = EnvironmentId.make("environment-test");
const endedAt = DateTime.makeUnsafe("2026-10-22T10:00:00.000Z");
const running = { attention: null, completion: null };

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

describe("decideThreadNotification", () => {
  it.each([undefined, "user"] as const)(
    "announces a completed turn the user started (%s)",
    (origin) => {
      const decision = decideThreadNotification(
        endedTurn({ status: "completed", ...(origin === undefined ? {} : { origin }) }),
        running,
      );
      expect(decision.kind).toBe("completion");
    },
  );

  it.each(["agent", "schedule", "wake"] as const)(
    "stays silent when a %s turn completes, and stays silent after",
    (origin) => {
      const completed = endedTurn({ status: "completed", origin });
      const decision = decideThreadNotification(completed, running);
      expect(decision.kind).toBeNull();
      expect(decision.marks.completion).toBe(DateTime.toEpochMillis(endedAt));
      expect(decideThreadNotification(completed, decision.marks).kind).toBeNull();
    },
  );

  it("still reports a failure of a turn another agent started", () => {
    const decision = decideThreadNotification(
      endedTurn({ status: "failed", origin: "agent" }),
      running,
    );
    expect(decision).toMatchObject({ kind: "input", status: "failed" });
  });

  it("still reports a question from a turn a schedule started", () => {
    const decision = decideThreadNotification(
      endedTurn({ status: "completed", origin: "schedule", asks: true }),
      running,
    );
    expect(decision).toMatchObject({ kind: "input", status: "input" });
  });

  it("announces an agent's call for the user once, while it works or after", () => {
    const attention = { reason: "Pick a release date", requestedAt: endedAt };
    const working = decideThreadNotification(
      endedTurn({ status: "running", origin: "agent", attention }),
      running,
    );
    expect(working.kind).toBe("attention");
    const done = decideThreadNotification(
      endedTurn({ status: "completed", origin: "agent", attention }),
      working.marks,
    );
    expect(done.kind).toBeNull();
    const again = decideThreadNotification(
      endedTurn({
        status: "completed",
        origin: "agent",
        attention: { ...attention, requestedAt: DateTime.add(endedAt, { minutes: 5 }) },
      }),
      done.marks,
    );
    expect(again.kind).toBe("attention");
  });

  it("does not announce a thread seen for the first time", () => {
    expect(decideThreadNotification(endedTurn({ status: "completed" }), undefined).kind).toBeNull();
  });
});
