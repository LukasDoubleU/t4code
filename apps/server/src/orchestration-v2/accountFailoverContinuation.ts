import { MessageId, type RunId } from "@t3tools/contracts";

const PREFIX = "message:account-failover:";

/** The message that continues `runId` on the next account after it hit its usage limit. */
export const accountFailoverMessageId = (runId: RunId) => MessageId.make(`${PREFIX}${runId}`);

export const isAccountFailoverMessage = (messageId: MessageId | null | undefined) =>
  messageId?.startsWith(PREFIX) === true;
