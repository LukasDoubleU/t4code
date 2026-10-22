import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { BrainIcon } from "lucide-react";

import { useRelativeTimeState } from "../hooks/useRelativeTimeState";
import { useEnvironmentQuery } from "../state/query";
import { threadMemoryMetadata, useThreadMemoryPath } from "../threadMemory";
import { threadMemoryTooltipLabel } from "../threadMemory.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** For a pinned card; shows nothing while the environment keeps no memories. */
export function ThreadMemoryIndicator(props: { readonly threadRef: ScopedThreadRef }) {
  const path = useThreadMemoryPath(props.threadRef, true);
  if (path === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Memory"
            className="inline-flex shrink-0 items-center text-muted-foreground/65"
          />
        }
      >
        <BrainIcon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <ThreadMemoryLastUpdate environmentId={props.threadRef.environmentId} path={path} />
      </TooltipPopup>
    </Tooltip>
  );
}

// Mounted only while the tooltip is open, so the file is checked on hover.
export function ThreadMemoryLastUpdate(props: {
  readonly environmentId: EnvironmentId;
  readonly path: string;
}) {
  const metadata = useEnvironmentQuery(
    threadMemoryMetadata({
      environmentId: props.environmentId,
      input: { paths: [props.path], includeModifiedAt: true },
    }),
  );
  const entry = metadata.data === null ? undefined : (metadata.data.entries[0] ?? null);
  const updated = useRelativeTimeState(entry?.modifiedAt ?? null);
  return threadMemoryTooltipLabel({
    entry,
    failed: metadata.error !== null,
    updated:
      updated.status !== "relative"
        ? null
        : updated.suffix === null
          ? updated.value
          : `${updated.value} ${updated.suffix}`,
  });
}
