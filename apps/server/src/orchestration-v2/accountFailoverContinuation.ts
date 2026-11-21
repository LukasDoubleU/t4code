import { MessageId, type OrchestrationV2Run, type RunId } from "@t3tools/contracts";

const PREFIX = "message:account-failover:";

/** The message that continues `runId` on the next account after it hit its usage limit. */
export const accountFailoverMessageId = (runId: RunId) => MessageId.make(`${PREFIX}${runId}`);

export const isAccountFailoverMessage = (messageId: MessageId | null | undefined) =>
  messageId?.startsWith(PREFIX) === true;

/** The run a chain of moves started from: the turn whose entries the fallback chain tried. */
export function moveOrigin(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run {
  let current = run;
  const seen = new Set<RunId>();
  while (
    isAccountFailoverMessage(current.userMessageId) &&
    current.manualContinuationOfRunId !== undefined &&
    !seen.has(current.id)
  ) {
    seen.add(current.id);
    const source = runs.find((candidate) => candidate.id === current.manualContinuationOfRunId);
    if (source === undefined) break;
    current = source;
  }
  return current;
}
