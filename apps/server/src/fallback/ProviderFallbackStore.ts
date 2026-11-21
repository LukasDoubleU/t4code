import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The provider fallback chain's own state: entry cool-downs and parking, the entries each turn
 * tried, the budget ledger and the schedule breaker. Its tables carry the fork's `t4_` prefix and
 * are created here rather than by a numbered migration, whose numbers belong to upstream.
 */
export class ProviderFallbackStoreError extends Schema.TaggedError<ProviderFallbackStoreError>()(
  "ProviderFallbackStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Provider fallback state could not be read or written (${this.operation}).`;
  }
}

export interface EntryState {
  /** An `entryKey`; parking, which is per account, uses the instance id alone. */
  readonly key: string;
  readonly cooldownUntil: number | null;
  /** Quota failures in a row without a reset time; the backoff doubles with each. */
  readonly failures: number;
  readonly parkedAt: number | null;
  readonly reason: string | null;
}

export interface Reservation {
  readonly id: string;
  readonly budgetKey: string;
  readonly month: string;
  readonly instanceId: string;
  readonly threadId: string;
  readonly runId: string;
  /** The most the run may spend: the per-run ceiling, or what the month has left if less. */
  readonly capUsd: number;
  readonly chargedUsd: number | null;
  /** The in-turn check stopped the run at its cap. */
  readonly stoppedAt: number | null;
}

export interface ReserveInput {
  readonly id: string;
  readonly budgetKey: string;
  readonly month: string;
  readonly instanceId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly monthlyUsd: number;
  readonly perRunUsd: number;
  readonly now: number;
}

const toError = (operation: string) => (cause: unknown) =>
  new ProviderFallbackStoreError({ operation, cause });

const num = (value: unknown): number | null =>
  typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export class ProviderFallbackStore extends Context.Service<
  ProviderFallbackStore,
  {
    readonly entryStates: () => Effect.Effect<
      ReadonlyArray<EntryState>,
      ProviderFallbackStoreError
    >;
    readonly coolDown: (input: {
      readonly key: string;
      readonly until: number | null;
      /** Without a reset time: the backoff from the failures so far, which this one adds to. */
      readonly backoff?: (failures: number) => number;
      readonly reason: string;
      readonly now: number;
    }) => Effect.Effect<number, ProviderFallbackStoreError>;
    /** A turn that completed on the entry clears its cool-down and backoff. */
    readonly clearCooldown: (key: string) => Effect.Effect<void, ProviderFallbackStoreError>;
    readonly park: (input: {
      readonly key: string;
      readonly reason: string;
      readonly now: number;
    }) => Effect.Effect<void, ProviderFallbackStoreError>;
    /** Re-enables a parked entry and lifts its cool-down. */
    readonly reenable: (key: string) => Effect.Effect<void, ProviderFallbackStoreError>;

    readonly tried: (input: {
      readonly threadId: string;
      readonly originRunId: string;
    }) => Effect.Effect<ReadonlySet<string>, ProviderFallbackStoreError>;
    readonly markTried: (input: {
      readonly threadId: string;
      readonly originRunId: string;
      readonly key: string;
      readonly now: number;
    }) => Effect.Effect<void, ProviderFallbackStoreError>;

    /** Atomic: null when the month has too little left for this run. Idempotent per id. */
    readonly reserve: (
      input: ReserveInput,
    ) => Effect.Effect<Reservation | null, ProviderFallbackStoreError>;
    readonly reservation: (
      id: string,
    ) => Effect.Effect<Reservation | null, ProviderFallbackStoreError>;
    readonly markStopped: (input: {
      readonly id: string;
      readonly now: number;
    }) => Effect.Effect<void, ProviderFallbackStoreError>;
    readonly settle: (input: {
      readonly id: string;
      readonly chargedUsd: number;
      readonly now: number;
    }) => Effect.Effect<void, ProviderFallbackStoreError>;
    /** Reservations still in flight, as a restart left them. */
    readonly openReservations: () => Effect.Effect<
      ReadonlyArray<Reservation>,
      ProviderFallbackStoreError
    >;
    /** Spent and reserved per budget key in a month. */
    readonly monthTotals: (
      month: string,
    ) => Effect.Effect<
      ReadonlyMap<string, { readonly spentUsd: number; readonly reservedUsd: number }>,
      ProviderFallbackStoreError
    >;

    /** Records how a scheduled run ended; returns the streak of runs that exhausted the chain. */
    readonly recordScheduleOutcome: (input: {
      readonly scheduleId: string;
      readonly exhausted: boolean;
      readonly now: number;
    }) => Effect.Effect<number, ProviderFallbackStoreError>;
    /** True once per streak: the caller that gets it pauses the schedule and asks for attention. */
    readonly tripBreaker: (input: {
      readonly scheduleId: string;
      readonly now: number;
    }) => Effect.Effect<boolean, ProviderFallbackStoreError>;
  }
>()("t3/fallback/ProviderFallbackStore") {}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS t4_fallback_entry_state (
    key TEXT PRIMARY KEY,
    cooldown_until INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    parked_at INTEGER,
    reason TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS t4_fallback_tried (
    thread_id TEXT NOT NULL,
    origin_run_id TEXT NOT NULL,
    key TEXT NOT NULL,
    tried_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, origin_run_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS t4_fallback_ledger (
    id TEXT PRIMARY KEY,
    budget_key TEXT NOT NULL,
    month TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    cap_usd REAL NOT NULL,
    charged_usd REAL,
    stopped_at INTEGER,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS t4_fallback_ledger_budget ON t4_fallback_ledger (budget_key, month)`,
  `CREATE TABLE IF NOT EXISTS t4_fallback_breaker (
    schedule_id TEXT PRIMARY KEY,
    streak INTEGER NOT NULL,
    tripped_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
];

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of SCHEMA) {
    yield* sql.unsafe(statement).pipe(Effect.mapError(toError("createTables")));
  }

  const toReservation = (row: Record<string, unknown>): Reservation => ({
    id: str(row.id) ?? "",
    budgetKey: str(row.budget_key) ?? "",
    month: str(row.month) ?? "",
    instanceId: str(row.instance_id) ?? "",
    threadId: str(row.thread_id) ?? "",
    runId: str(row.run_id) ?? "",
    capUsd: num(row.cap_usd) ?? 0,
    chargedUsd: num(row.charged_usd),
    stoppedAt: num(row.stopped_at),
  });

  const reservation = (id: string) =>
    sql<Record<string, unknown>>`SELECT * FROM t4_fallback_ledger WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toReservation(rows[0]))),
      Effect.mapError(toError("reservation")),
    );

  return ProviderFallbackStore.of({
    entryStates: Effect.fn("ProviderFallbackStore.entryStates")(function* () {
      return yield* sql<Record<string, unknown>>`SELECT * FROM t4_fallback_entry_state`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            key: str(row.key) ?? "",
            cooldownUntil: num(row.cooldown_until),
            failures: num(row.failures) ?? 0,
            parkedAt: num(row.parked_at),
            reason: str(row.reason),
          })),
        ),
        Effect.mapError(toError("entryStates")),
      );
    }),

    coolDown: Effect.fn("ProviderFallbackStore.coolDown")(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              failures: number;
            }>`SELECT failures FROM t4_fallback_entry_state WHERE key = ${input.key}`;
            const failures = input.until === null ? (num(rows[0]?.failures) ?? 0) + 1 : 0;
            const until =
              input.until ??
              input.now + (input.backoff === undefined ? 0 : input.backoff(failures));
            yield* sql`
                INSERT INTO t4_fallback_entry_state (key, cooldown_until, failures, reason, updated_at)
                VALUES (${input.key}, ${until}, ${failures}, ${input.reason}, ${input.now})
                ON CONFLICT (key) DO UPDATE SET
                  cooldown_until = excluded.cooldown_until,
                  failures = excluded.failures,
                  reason = excluded.reason,
                  updated_at = excluded.updated_at
              `;
            return until;
          }),
        )
        .pipe(Effect.mapError(toError("coolDown")));
    }),

    clearCooldown: Effect.fn("ProviderFallbackStore.clearCooldown")(function* (key) {
      return yield* sql`
          UPDATE t4_fallback_entry_state SET cooldown_until = NULL, failures = 0
          WHERE key = ${key} AND (cooldown_until IS NOT NULL OR failures != 0)
        `.pipe(Effect.asVoid, Effect.mapError(toError("clearCooldown")));
    }),

    park: Effect.fn("ProviderFallbackStore.park")(function* (input) {
      return yield* sql`
          INSERT INTO t4_fallback_entry_state (key, parked_at, reason, updated_at)
          VALUES (${input.key}, ${input.now}, ${input.reason}, ${input.now})
          ON CONFLICT (key) DO UPDATE SET
            parked_at = excluded.parked_at,
            reason = excluded.reason,
            updated_at = excluded.updated_at
        `.pipe(Effect.asVoid, Effect.mapError(toError("park")));
    }),

    reenable: Effect.fn("ProviderFallbackStore.reenable")(function* (key) {
      return yield* sql`
          UPDATE t4_fallback_entry_state
          SET parked_at = NULL, cooldown_until = NULL, failures = 0, reason = NULL
          WHERE key = ${key} OR substr(key, 1, ${key.length + 1}) = ${`${key}|`}
        `.pipe(Effect.asVoid, Effect.mapError(toError("reenable")));
    }),

    tried: Effect.fn("ProviderFallbackStore.tried")(function* (input) {
      return yield* sql<{ key: string }>`
          SELECT key FROM t4_fallback_tried
          WHERE thread_id = ${input.threadId} AND origin_run_id = ${input.originRunId}
        `.pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.key))),
        Effect.mapError(toError("tried")),
      );
    }),

    markTried: Effect.fn("ProviderFallbackStore.markTried")(function* (input) {
      return yield* sql`
          INSERT INTO t4_fallback_tried (thread_id, origin_run_id, key, tried_at)
          VALUES (${input.threadId}, ${input.originRunId}, ${input.key}, ${input.now})
          ON CONFLICT DO NOTHING
        `.pipe(Effect.asVoid, Effect.mapError(toError("markTried")));
    }),

    reserve: Effect.fn("ProviderFallbackStore.reserve")(function* (input) {
      const existing = yield* reservation(input.id);
      if (existing !== null) return existing;
      // One statement, so two runs on the same budget cannot both take its last room.
      const rows = yield* sql<Record<string, unknown>>`
          INSERT INTO t4_fallback_ledger
            (id, budget_key, month, instance_id, thread_id, run_id, cap_usd, created_at)
          SELECT ${input.id}, ${input.budgetKey}, ${input.month}, ${input.instanceId},
            ${input.threadId}, ${input.runId}, MIN(${input.perRunUsd}, ${input.monthlyUsd} - used),
            ${input.now}
          FROM (
            SELECT COALESCE(SUM(COALESCE(charged_usd, cap_usd)), 0) AS used
            FROM t4_fallback_ledger
            WHERE budget_key = ${input.budgetKey} AND month = ${input.month}
          )
          WHERE ${input.monthlyUsd} - used >= ${input.perRunUsd} / 10.0
          ON CONFLICT (id) DO NOTHING
          RETURNING *
        `.pipe(Effect.mapError(toError("reserve")));
      if (rows[0] !== undefined) return toReservation(rows[0]);
      return yield* reservation(input.id);
    }),

    reservation,

    markStopped: Effect.fn("ProviderFallbackStore.markStopped")(function* (input) {
      return yield* sql`
          UPDATE t4_fallback_ledger SET stopped_at = ${input.now}
          WHERE id = ${input.id} AND stopped_at IS NULL
        `.pipe(Effect.asVoid, Effect.mapError(toError("markStopped")));
    }),

    settle: Effect.fn("ProviderFallbackStore.settle")(function* (input) {
      return yield* sql`
          UPDATE t4_fallback_ledger
          SET charged_usd = ${input.chargedUsd}, settled_at = ${input.now}
          WHERE id = ${input.id} AND charged_usd IS NULL
        `.pipe(Effect.asVoid, Effect.mapError(toError("settle")));
    }),

    openReservations: Effect.fn("ProviderFallbackStore.openReservations")(function* () {
      return yield* sql<Record<string, unknown>>`
          SELECT * FROM t4_fallback_ledger WHERE charged_usd IS NULL
        `.pipe(
        Effect.map((rows) => rows.map(toReservation)),
        Effect.mapError(toError("openReservations")),
      );
    }),

    monthTotals: Effect.fn("ProviderFallbackStore.monthTotals")(function* (month) {
      return yield* sql<Record<string, unknown>>`
          SELECT budget_key,
            COALESCE(SUM(charged_usd), 0) AS spent,
            COALESCE(SUM(CASE WHEN charged_usd IS NULL THEN cap_usd ELSE 0 END), 0) AS reserved
          FROM t4_fallback_ledger WHERE month = ${month}
          GROUP BY budget_key
        `.pipe(
        Effect.map(
          (rows) =>
            new Map(
              rows.map((row) => [
                str(row.budget_key) ?? "",
                { spentUsd: num(row.spent) ?? 0, reservedUsd: num(row.reserved) ?? 0 },
              ]),
            ),
        ),
        Effect.mapError(toError("monthTotals")),
      );
    }),

    recordScheduleOutcome: Effect.fn("ProviderFallbackStore.recordScheduleOutcome")(
      function* (input) {
        return yield* sql<{ streak: number }>`
          INSERT INTO t4_fallback_breaker (schedule_id, streak, updated_at)
          VALUES (${input.scheduleId}, ${input.exhausted ? 1 : 0}, ${input.now})
          ON CONFLICT (schedule_id) DO UPDATE SET
            streak = CASE WHEN ${input.exhausted ? 1 : 0} = 1 THEN streak + 1 ELSE 0 END,
            tripped_at = CASE WHEN ${input.exhausted ? 1 : 0} = 1 THEN tripped_at ELSE NULL END,
            updated_at = excluded.updated_at
          RETURNING streak
        `.pipe(
          Effect.map((rows) => num(rows[0]?.streak) ?? 0),
          Effect.mapError(toError("recordScheduleOutcome")),
        );
      },
    ),

    tripBreaker: Effect.fn("ProviderFallbackStore.tripBreaker")(function* (input) {
      return yield* sql<{ schedule_id: string }>`
          UPDATE t4_fallback_breaker SET tripped_at = ${input.now}
          WHERE schedule_id = ${input.scheduleId} AND tripped_at IS NULL
          RETURNING schedule_id
        `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toError("tripBreaker")),
      );
    }),
  });
});

export const layer = Layer.effect(ProviderFallbackStore, make);

/** Cool-downs are per entry: Antigravity's quota, for one, is per model family. */
export const entryKey = (instanceId: string, model: string) => `${instanceId}|${model}`;
