import {
  threadMemoryFilePath,
  type FilesystemEntryMetadata,
  type ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "./i18n/messages";

/** Null while an environment keeps no memories: a server without them, or the setting off. */
export function activeThreadMemoryDirectory(
  config: {
    readonly threadMemoryDirectory?: string;
    readonly settings: { readonly pinnedThreadsKeepMemory: boolean };
  } | null,
): string | null {
  if (config === null || !config.settings.pinnedThreadsKeepMemory) return null;
  return config.threadMemoryDirectory ?? null;
}

/** A thread's memory file while its memory is active, otherwise null. */
export function activeThreadMemoryPath(input: {
  readonly directory: string | null;
  readonly pinned: boolean;
  readonly threadId: ThreadId;
}): string | null {
  return input.pinned && input.directory !== null
    ? threadMemoryFilePath(input.directory, input.threadId)
    : null;
}

/** From this many turns without a change to the memory file, its tooltip says so. */
export const MEMORY_STALE_TURNS = 20;

/**
 * `entry` is undefined until the server answers and null when the file does
 * not exist yet; `updated` is its modification time as "5m ago".
 * `unchangedTurns` counts the turns since the file last changed.
 */
export function threadMemoryTooltipLabel(
  input: {
    readonly entry: FilesystemEntryMetadata | null | undefined;
    readonly failed: boolean;
    readonly updated: string | null;
    readonly unchangedTurns?: number | undefined;
  },
  resolve: MessageResolver = m,
): string {
  if (input.entry === undefined)
    return input.failed ? resolve(msg("Memory")) : resolve(msg("Memory…"));
  const stale =
    input.unchangedTurns !== undefined && input.unchangedTurns >= MEMORY_STALE_TURNS
      ? input.unchangedTurns
      : null;
  if (input.entry === null || input.entry.kind !== "file") {
    return stale === null
      ? resolve(msg("No notes yet"))
      : resolve(
          msg("No notes yet after {count, plural, one {{count} turn} other {{count} turns}}", {
            count: stale,
          }),
        );
  }
  const label =
    input.updated === null
      ? resolve(msg("Memory"))
      : resolve(msg("Memory updated {updated}", { updated: input.updated }));
  return stale === null
    ? label
    : resolve(
        msg("{label} · unchanged for {count, plural, one {{count} turn} other {{count} turns}}", {
          label,
          count: stale,
        }),
      );
}
