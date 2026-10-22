import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, RunId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import { decideThreadNotification } from "./ThreadNotificationCoordinator.logic";

const environmentId = EnvironmentId.make("environment-test");
const endedAt = DateTime.makeUnsafe("2026-10-22T10:00:00.000Z");
const running = { attention: null, completion: null };

function endedTurn(input: {
  readonly status: "completed" | "failed";
  readonly fromAnotherAgent: boolean;
  readonly asks?: boolean;
}) {
  return presentThreadShell(environmentId, {
    ...makeThreadFixture().source,
    latestRunId: RunId.make("run-1"),
    status: input.status,
    latestRunCompletedAt: endedAt,
    latestRunFromAnotherAgent: input.fromAnotherAgent,
    pendingRuntimeRequest: input.asks
      ? { id: RuntimeRequestId.make("request-1"), kind: "user_input", createdAt: endedAt }
      : null,
  });
}

describe("decideThreadNotification", () => {
  it("announces a completed turn the user started", () => {
    const decision = decideThreadNotification(
      endedTurn({ status: "completed", fromAnotherAgent: false }),
      running,
    );
    expect(decision.kind).toBe("completion");
  });

  it("stays silent when a turn another agent started completes, and stays silent after", () => {
    const completed = endedTurn({ status: "completed", fromAnotherAgent: true });
    const decision = decideThreadNotification(completed, running);
    expect(decision.kind).toBeNull();
    expect(decision.marks.completion).toBe(DateTime.toEpochMillis(endedAt));
    expect(decideThreadNotification(completed, decision.marks).kind).toBeNull();
  });

  it("still reports a failure of a turn another agent started", () => {
    const decision = decideThreadNotification(
      endedTurn({ status: "failed", fromAnotherAgent: true }),
      running,
    );
    expect(decision).toMatchObject({ kind: "input", status: "failed" });
  });

  it("still reports a question from a turn another agent started", () => {
    const decision = decideThreadNotification(
      endedTurn({ status: "completed", fromAnotherAgent: true, asks: true }),
      running,
    );
    expect(decision).toMatchObject({ kind: "input", status: "input" });
  });

  it("does not announce a thread seen for the first time", () => {
    expect(
      decideThreadNotification(
        endedTurn({ status: "completed", fromAnotherAgent: false }),
        undefined,
      ).kind,
    ).toBeNull();
  });
});
