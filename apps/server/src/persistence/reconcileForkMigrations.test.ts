import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";
import { forkMigrationNames } from "./reconcileForkMigrations.ts";

const forkStart = migrationEntries.length - forkMigrationNames.length;
const upstreamEntries = migrationEntries.slice(0, forkStart);
const latestUpstreamId = Math.max(...upstreamEntries.map(([id]) => id));

const createTable = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE ${sql(table)} (id INTEGER PRIMARY KEY)`;
  });

// The manifest after an upstream merge that brought two new migrations, with
// the fork's renumbered after them.
const nextOfficialEntries = [
  ...upstreamEntries,
  [latestUpstreamId + 1, "NextUpstreamFirst", createTable("next_upstream_first")] as const,
  [latestUpstreamId + 2, "NextUpstreamSecond", createTable("next_upstream_second")] as const,
];
const nextEntries = [
  ...nextOfficialEntries,
  ...migrationEntries
    .slice(forkStart)
    .map(([, name, migration], index) => [latestUpstreamId + 3 + index, name, migration] as const),
];
const nextManifest = nextEntries.map(([id, name]) => [id, name] as const);

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

// With their timestamps, so a row deleted and recorded again shows.
const historyRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
});

const ageHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-01-01 00:00:00'`;
});

const forkSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`
    SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name = 'peer_environment_links'
      OR name = 'orchestration_v2_projection_turn_items_waiting_link_idx'
    ORDER BY name
  `;
});

const peerLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM peer_environment_links`;
});

const seedPeerLink = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO peer_environment_links
      (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced)
    VALUES ('peer', 'peer-link-1', 'Peer', '[]', 'full', '2026-10-01', '2026-11-01', 1)
  `;
});

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

describe("fork migrations", () => {
  it.effect("follow upstream's in the manifest", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationManifest.slice(forkStart).map(([, name]) => name),
        [...forkMigrationNames],
      );
    }),
  );

  it.effect.each([
    ["today's manifest", migrationEntries],
    ["a manifest with upstream migrations inserted", nextEntries],
  ] as const)("run last on a fresh database, with %s", ([, entries]) =>
    withDatabase(
      Effect.gen(function* () {
        const manifest = entries.map(([id, name]) => [id, name] as const);
        assert.deepStrictEqual(yield* runMigrations({ entries }), manifest);
        assert.deepStrictEqual(yield* history, manifest);
      }),
    ),
  );

  it.effect("leave a database at the fork's latest migration unchanged", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedPeerLink;
        yield* ageHistory;
        const before = yield* historyRows;
        const links = yield* peerLinks;

        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* historyRows, before);
        assert.deepStrictEqual(yield* peerLinks, links);
      }),
    ),
  );

  const moveAfterUpstream = Effect.gen(function* () {
    yield* runMigrations();
    yield* seedPeerLink;
    yield* ageHistory;
    const schema = yield* forkSchema;
    const links = yield* peerLinks;

    assert.deepStrictEqual(
      yield* runMigrations({ entries: nextEntries }),
      nextManifest.slice(forkStart),
    );
    return { schema, links };
  });

  it.effect("run again after upstream's new migrations, changing nothing", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { schema, links } = yield* moveAfterUpstream;

        assert.deepStrictEqual(yield* history, nextManifest);
        assert.deepStrictEqual(yield* forkSchema, schema);
        assert.deepStrictEqual(yield* peerLinks, links);
        assert.lengthOf(
          yield* sql`
            SELECT name FROM sqlite_master
            WHERE name IN ('next_upstream_first', 'next_upstream_second')
          `,
          2,
        );
        assert.deepStrictEqual(
          yield* sql`
            SELECT DISTINCT created_at FROM effect_sql_migrations
            WHERE migration_id <= ${latestUpstreamId}
          `,
          [{ created_at: "2026-01-01 00:00:00" }],
        );
      }),
    ),
  );

  it.effect("stay put on the next start after moving", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* moveAfterUpstream;
        const before = yield* historyRows;

        assert.deepStrictEqual(yield* runMigrations({ entries: nextEntries }), []);
        assert.deepStrictEqual(yield* historyRows, before);
      }),
    ),
  );

  it.effect.each([
    ["today's", latestUpstreamId, migrationEntries],
    ["the next", latestUpstreamId + 2, nextEntries],
  ] as const)("run on top of an official database from %s upstream", ([, officialId, entries]) =>
    withDatabase(
      Effect.gen(function* () {
        const manifest = entries.map(([id, name]) => [id, name] as const);
        yield* runMigrations({ entries: nextOfficialEntries, toMigrationInclusive: officialId });

        assert.deepStrictEqual(
          yield* runMigrations({ entries }),
          manifest.filter(([id]) => id > officialId),
        );
        assert.deepStrictEqual(yield* history, manifest);
      }),
    ),
  );

  it.effect("stay recorded when an upstream migration fails", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* runMigrations();
        const before = yield* historyRows;
        const failing = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT * FROM missing_table`;
        });

        const exit = yield* Effect.exit(
          runMigrations({
            entries: nextEntries.map(
              ([id, name, migration]) =>
                [id, name, id === latestUpstreamId + 2 ? failing : migration] as const,
            ),
          }),
        );

        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(yield* historyRows, before);
      }),
    ),
  );

  it.effect("refuse a database from a newer upstream base without changing it", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* runMigrations({ entries: nextEntries });
        const before = yield* historyRows;

        const exit = yield* Effect.exit(runMigrations());

        assert.isTrue(Exit.isFailure(exit));
        assert.include(
          String(exit),
          `${latestUpstreamId + 1}_${forkMigrationNames[0]} (recorded: NextUpstreamFirst)`,
        );
        assert.deepStrictEqual(yield* historyRows, before);
      }),
    ),
  );
});
