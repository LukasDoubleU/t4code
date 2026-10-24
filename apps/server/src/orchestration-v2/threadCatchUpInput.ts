import {
  isOrchestrationV2MessageFromAnotherAgent,
  type OrchestrationV2AttentionRequest,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Turn items a brief reads besides messages: open requests, failures and edited files. */
export const CATCH_UP_TURN_ITEM_TYPES = [
  "approval_request",
  "user_input_request",
  "error",
  "file_change",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

// A busy thread must not turn into a huge prompt: the newest items keep their detail until
// FULL_DETAIL_CHARS are used, older ones shrink to a line, and nothing past ITEMS_BUDGET is sent.
const ITEMS_BUDGET = 24_000;
const FULL_DETAIL_CHARS = 16_000;
const FULL_ITEM_CHARS = 4_000;
const CONDENSED_ITEM_CHARS = 300;
const MAX_LISTED_FILES = 20;

type CatchUpMessage = Pick<
  OrchestrationV2ConversationMessage,
  | "role"
  | "text"
  | "attachments"
  | "streaming"
  | "createdAt"
  | "createdBy"
  | "creationSource"
  | "scheduledTaskId"
  | "senderThreadId"
  | "delegatedCompletion"
  | "notification"
  | "workflowScript"
>;

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** Mirrors the shell's `latestUserAuthoredMessageAt`: wakes and agent messages also use the user role. */
export function isUserAuthoredMessage(message: Pick<CatchUpMessage, "role" | "createdBy">) {
  return message.role === "user" && message.createdBy === "user";
}

/**
 * Where the brief starts: the user's latest message or their last visit, whichever is earlier.
 * Null reads the whole thread.
 */
export function catchUpStart(input: {
  readonly messages: ReadonlyArray<Pick<CatchUpMessage, "role" | "createdBy" | "createdAt">>;
  readonly lastVisitedAt: DateTime.Utc | null;
}): DateTime.Utc | null {
  let latestOwn: DateTime.Utc | null = null;
  for (const message of input.messages) {
    if (!isUserAuthoredMessage(message)) continue;
    if (latestOwn === null || DateTime.isGreaterThan(message.createdAt, latestOwn)) {
      latestOwn = message.createdAt;
    }
  }
  if (latestOwn === null || input.lastVisitedAt === null) return null;
  return DateTime.min(latestOwn, input.lastVisitedAt);
}

/** Runs whose items can belong in the brief: started since `start`, or still going. */
export function catchUpRunIds(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "requestedAt">>,
  start: DateTime.Utc | null,
): ReadonlyArray<RunId> {
  return runs
    .filter(
      (run) =>
        start === null ||
        ACTIVE_RUN_STATUSES.has(run.status) ||
        !DateTime.isLessThan(run.requestedAt, start),
    )
    .map((run) => run.id);
}

function messageLabel(message: CatchUpMessage): string {
  if (message.role === "assistant") return "Agent";
  if (message.role === "system") return "System";
  if (message.scheduledTaskId !== undefined) return "Scheduled task";
  if (isUserAuthoredMessage(message)) return "You";
  if (isOrchestrationV2MessageFromAnotherAgent(message)) {
    return message.delegatedCompletion !== undefined ||
      message.notification?.source.kind === "delegated_task"
      ? "Delegated task report"
      : "Message from another thread";
  }
  return "Wake-up";
}

function messageBody(message: CatchUpMessage): string {
  const text = message.workflowScript ? "(started a workflow)" : message.text.trim();
  const attachments =
    message.attachments.length === 0
      ? ""
      : ` [${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}]`;
  return `${text}${attachments}${message.streaming ? " (still writing)" : ""}`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  // The start says what an item is about and the end often holds its conclusion.
  const head = Math.ceil(max * 0.6);
  const tail = max - head - 3;
  return `${text.slice(0, head).trimEnd()} … ${text.slice(text.length - tail).trimStart()}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface CatchUpLine {
  readonly at: DateTime.Utc;
  readonly label: string;
  readonly body: string;
}

function approvalSummary(item: Extract<OrchestrationV2TurnItem, { type: "approval_request" }>) {
  return oneLine(item.prompt ?? item.reason ?? item.title ?? item.requestKind);
}

/** Open requests on the user, as facts the brief's "Needs you" may not contradict. */
export function catchUpWaitingOnUser(input: {
  readonly attention: Pick<OrchestrationV2AttentionRequest, "reason"> | null | undefined;
  readonly runtimeRequests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "id" | "status">>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): ReadonlyArray<string> {
  const pending = new Set(
    input.runtimeRequests
      .filter((request) => request.status === "pending")
      .map((request) => request.id),
  );
  const facts: string[] = [];
  for (const item of input.turnItems) {
    if (item.type === "approval_request" && pending.has(item.requestId)) {
      facts.push(`The agent waits for your approval: ${clip(approvalSummary(item), 400)}`);
    } else if (item.type === "user_input_request" && pending.has(item.requestId)) {
      const questions = item.questions.map((question) => oneLine(question.question)).join(" ");
      facts.push(`The agent asks you: ${clip(questions, 400)}`);
    }
  }
  if (input.attention) {
    facts.push(`The agent asked for you: ${oneLine(input.attention.reason)}`);
  }
  return facts;
}

/** The thread's items since `start` as capped plain text, oldest first. */
export function catchUpItemsText(input: {
  readonly start: DateTime.Utc | null;
  readonly messages: ReadonlyArray<CatchUpMessage>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): string {
  const since = (at: DateTime.Utc) => input.start === null || !DateTime.isLessThan(at, input.start);
  const lines: CatchUpLine[] = [];
  for (const message of input.messages) {
    if (!since(message.createdAt)) continue;
    lines.push({ at: message.createdAt, label: messageLabel(message), body: messageBody(message) });
  }
  const files: string[] = [];
  for (const item of input.turnItems) {
    const at = item.startedAt ?? item.updatedAt;
    if (!since(at)) continue;
    if (item.type === "file_change" && !files.includes(item.fileName)) files.push(item.fileName);
    if (item.type === "error") lines.push({ at, label: "Error", body: item.failure.message });
  }
  lines.sort((left, right) => DateTime.Order(left.at, right.at));

  const kept: string[] = [];
  let used = 0;
  let firstKept = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const max = used < FULL_DETAIL_CHARS ? FULL_ITEM_CHARS : CONDENSED_ITEM_CHARS;
    const text = `${line.label}: ${clip(max === FULL_ITEM_CHARS ? line.body : oneLine(line.body), max)}`;
    if (used + text.length > ITEMS_BUDGET) break;
    kept.push(text);
    used += text.length + 1;
    firstKept = index;
  }
  kept.reverse();
  if (firstKept > 0) {
    const first = lines[0]!;
    // The oldest item is usually the user's own ask, which frames everything after it.
    const omitted = firstKept - 1;
    kept.unshift(
      ...[
        `${first.label}: ${clip(oneLine(first.body), CONDENSED_ITEM_CHARS)}`,
        ...(omitted > 0 ? [`[${omitted} more item${omitted === 1 ? "" : "s"} left out]`] : []),
      ],
    );
  }
  if (files.length > 0) {
    const listed = files.slice(0, MAX_LISTED_FILES).join(", ");
    const more =
      files.length > MAX_LISTED_FILES ? ` and ${files.length - MAX_LISTED_FILES} more` : "";
    kept.push(`Files the agent changed: ${listed}${more}`);
  }
  return kept.join("\n");
}
