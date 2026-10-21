import {
  threadMemoryFilePath,
  type FilesystemEntryMetadata,
  type ThreadId,
} from "@t3tools/contracts";

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

/**
 * `entry` is undefined until the server answers and null when the file does
 * not exist yet; `updated` is its modification time as "5m ago".
 */
export function threadMemoryTooltipLabel(input: {
  readonly entry: FilesystemEntryMetadata | null | undefined;
  readonly failed: boolean;
  readonly updated: string | null;
}): string {
  if (input.entry === undefined) return input.failed ? "Memory" : "Memory…";
  if (input.entry === null || input.entry.kind !== "file") return "No notes yet";
  return input.updated === null ? "Memory" : `Memory updated ${input.updated}`;
}
