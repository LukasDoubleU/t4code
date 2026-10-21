import type { ThreadId } from "./baseSchemas.ts";

/** Thread ids contain `:`, which Windows does not allow in file names. */
export function threadMemoryFileName(threadId: ThreadId): string {
  return `${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`;
}

/**
 * Joins with the separator the server's directory already uses, so a client
 * on another platform names the same file the server does.
 */
export function threadMemoryFilePath(directory: string, threadId: ThreadId): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  const prefix = directory.endsWith(separator) ? directory : `${directory}${separator}`;
  return `${prefix}${threadMemoryFileName(threadId)}`;
}
