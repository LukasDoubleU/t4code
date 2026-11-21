import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { backoffMs } from "./fallbackChain.ts";
import * as Store from "./ProviderFallbackStore.ts";

/** Each call opens the database file anew, as a server restart does. */
const withStore = <A, E>(
  file: string,
  use: (store: Store.ProviderFallbackStore["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(Store.ProviderFallbackStore, use).pipe(
    Effect.provide(Store.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: file })))),
  );

const tempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t4-fallback-store-" });
  return `${directory}/state.sqlite`;
});

const entry = Store.entryKey("antigravity", "gemini-3-pro");
const otherModel = Store.entryKey("antigravity", "gemini-3-flash");

const reserveInput = (id: string, now = 1_000) => ({
  id,
  budgetKey: "group:gemini-key",
  month: "2026-11",
  instanceId: "antigravity_api",
  threadId: "thread",
  runId: id,
  monthlyUsd: 10,
  perRunUsd: 4,
  now,
});

describe("ProviderFallbackStore", () => {
  it.effect("keeps cool-downs, parking and the tried set across a restart", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase;
      yield* withStore(file, (store) =>
        Effect.gen(function* () {
          const stop = (runId: string) =>
            store.coolDown({
              key: entry,
              until: null,
              backoff: backoffMs,
              reason: "quota",
              now: 0,
              runId,
            });
          assert.equal(yield* stop("run-1"), backoffMs(1));
          // The same run reported again, as its checkpoint does, counts once.
          assert.equal(yield* stop("run-1"), backoffMs(1));
          // A second failure in a row without a reset time doubles the wait.
          assert.equal(yield* stop("run-2"), backoffMs(2));
          yield* store.coolDown({
            key: otherModel,
            until: 5_000,
            reason: "quota",
            now: 0,
            runId: "run-3",
          });
          yield* store.park({ key: "antigravity_api", reason: "Out of credit", now: 0 });
          yield* store.markTried({ threadId: "t", originRunId: "r", key: entry, now: 0 });
          yield* store.markTried({ threadId: "t", originRunId: "r", key: entry, now: 1 });
        }),
      );

      const after = yield* withStore(file, (store) =>
        Effect.all({
          states: store.entryStates(),
          tried: store.tried({ threadId: "t", originRunId: "r" }),
          otherTurn: store.tried({ threadId: "t", originRunId: "other" }),
        }),
      );
      const byKey = new Map(after.states.map((state) => [state.key, state]));
      assert.equal(byKey.get(entry)?.cooldownUntil, backoffMs(2));
      assert.equal(byKey.get(entry)?.failures, 2);
      assert.equal(byKey.get(otherModel)?.cooldownUntil, 5_000);
      assert.equal(byKey.get("antigravity_api")?.parkedAt, 0);
      assert.deepStrictEqual([...after.tried], [entry]);
      assert.equal(after.otherTurn.size, 0);

      // A turn that started before the entry stopped, on another thread, leaves the cool-down.
      const cleared = yield* withStore(file, (store) =>
        Effect.gen(function* () {
          yield* store.clearCooldown({ key: otherModel, startedAt: 0 });
          const kept = (yield* store.entryStates()).find((state) => state.key === otherModel);
          yield* store.clearCooldown({ key: otherModel, startedAt: 1 });
          const gone = (yield* store.entryStates()).find((state) => state.key === otherModel);
          return { kept: kept?.cooldownUntil, gone: gone?.cooldownUntil };
        }),
      );
      assert.deepStrictEqual(cleared, { kept: 5_000, gone: null });

      // Re-enabling an instance lifts its parking and every model's cool-down on it.
      const reenabled = yield* withStore(file, (store) =>
        store.reenable("antigravity").pipe(Effect.andThen(store.entryStates())),
      );
      for (const state of reenabled.filter((state) => state.key.startsWith("antigravity|"))) {
        assert.equal(state.cooldownUntil, null);
        assert.equal(state.failures, 0);
      }
      assert.equal(
        reenabled.find((state) => state.key === "antigravity_api")?.parkedAt,
        0,
        "another instance stays parked",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reserves a budget group's room atomically, once per run", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase;
      const reservations = yield* withStore(file, (store) =>
        Effect.forEach(["a", "b", "c", "d"], (id) => store.reserve(reserveInput(id)), {
          concurrency: "unbounded",
        }),
      );
      // 10 USD a month at 4 per run: two full runs, one with the 2 left, then no room.
      assert.deepStrictEqual(
        reservations.map((reservation) => reservation?.capUsd ?? null).toSorted(),
        [2, 4, 4, null].toSorted(),
      );

      const again = yield* withStore(file, (store) => store.reserve(reserveInput("a")));
      assert.equal(
        again?.capUsd,
        reservations[0]?.capUsd,
        "a retried start reuses its reservation",
      );

      // Reservations still in flight survive a restart and keep their room taken.
      const open = yield* withStore(file, (store) => store.openReservations());
      assert.equal(open.length, 3);

      const settled = yield* withStore(file, (store) =>
        Effect.gen(function* () {
          const first = open.find((reservation) => reservation.capUsd === 4)!;
          yield* store.settle({ id: first.id, chargedUsd: 1, now: 2_000 });
          // A second settle cannot change what was charged.
          yield* store.settle({ id: first.id, chargedUsd: 4, now: 3_000 });
          return {
            totals: yield* store.monthTotals("2026-11"),
            next: yield* store.reserve(reserveInput("e")),
          };
        }),
      );
      assert.equal(settled.next?.capUsd, 3);
      assert.deepStrictEqual(settled.totals.get("group:gemini-key"), {
        spentUsd: 1,
        reservedUsd: 6,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("trips a schedule's breaker once per streak of runs", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase;
      yield* withStore(file, (store) =>
        Effect.gen(function* () {
          const outcome = (runId: string, exhausted: boolean) =>
            store.recordScheduleOutcome({ scheduleId: "s", runId, exhausted, now: 0 });
          const trip = store.tripBreaker({ scheduleId: "s", threshold: 3, now: 0 });
          assert.equal(yield* outcome("a", true), 1);
          // A run reported twice counts once.
          assert.equal(yield* outcome("a", true), 1);
          assert.equal(yield* outcome("b", true), 2);
          assert.isFalse(yield* trip);
          assert.equal(yield* outcome("c", true), 3);
          assert.isTrue(yield* trip);
          assert.isFalse(yield* trip, "once per streak");
          // Turned back on, the schedule pauses again after another full streak.
          assert.equal(yield* outcome("d", true), 1);
          // A run that gets through ends the streak.
          assert.equal(yield* outcome("e", false), 0);
          yield* outcome("f", true);
          yield* outcome("g", true);
          yield* outcome("h", true);
          assert.isTrue(yield* trip);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
