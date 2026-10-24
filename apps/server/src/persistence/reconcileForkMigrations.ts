import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * This fork's own migrations, in manifest order. They always follow upstream's:
 * each upstream merge renumbers them after upstream's latest id, with these
 * names unchanged, so each must change nothing when it runs again.
 */
export const forkMigrationNames = [
  "PeerLinks",
  "PeerLinkFence",
  "WaitingLinkRequestIndex",
] as const;

/**
 * Forgets each fork migration recorded at an id the manifest no longer gives
 * it, usually because upstream took that id. The migrator only runs ids above
 * the highest recorded one, so upstream's new migrations then run, and the
 * fork's run again at their new ids.
 */
export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* (
  manifest: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return [];
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
    WHERE name IN ${sql.in(forkMigrationNames)}
  `;
  const stale = recorded.filter(
    (row) => !manifest.some(([id, name]) => id === row.migration_id && name === row.name),
  );
  if (stale.length === 0) return [];
  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id IN ${sql.in(stale.map((row) => row.migration_id))}
  `;
  return stale.map((row) => [row.migration_id, row.name] as const);
});
