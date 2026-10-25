import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRelativeTimeState } from "../hooks/useRelativeTimeState";
import { useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { threadMemoryMetadata } from "../threadMemory";
import { threadMemoryTooltipLabel } from "../threadMemory.logic";

// Mounted only while the hover card is open, so the file is checked on hover.
export function ThreadMemoryLastUpdate(props: {
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
}) {
  const metadata = useEnvironmentQuery(
    threadMemoryMetadata({
      environmentId: props.threadRef.environmentId,
      input: { paths: [props.path], includeModifiedAt: true },
    }),
  );
  const thread = useThreadShell(props.threadRef);
  const entry = metadata.data === null ? undefined : (metadata.data.entries[0] ?? null);
  const updated = useRelativeTimeState(entry?.modifiedAt ?? null);
  return threadMemoryTooltipLabel({
    entry,
    failed: metadata.error !== null,
    unchangedTurns: thread?.source.memoryUnchangedTurns,
    updated:
      updated.status !== "relative"
        ? null
        : updated.suffix === null
          ? updated.value
          : `${updated.value} ${updated.suffix}`,
  });
}
