import type {
  EventId,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

/*
 * Each Claude account is its own config directory. A thread moving between two keeps its session:
 * once the old account's process has ended, turn start copies the session into the new directory
 * and resumes it. The original stays; only the current account's copy is live. Anything that
 * blocks a safe copy leaves the turn to the summary handoff.
 */

const HOME_KEY_PREFIX = "claude:home:";

/** The config directory in a key from `makeClaudeContinuationGroupKey`. */
export const claudeHomeOf = (continuationKey: string): string | null =>
  continuationKey.startsWith(HOME_KEY_PREFIX)
    ? continuationKey.slice(HOME_KEY_PREFIX.length)
    : null;

/** A session moves between two Claude homes by copying, so the move can resume it. */
export const canCarrySession = (currentKey: string, targetKey: string): boolean =>
  claudeHomeOf(currentKey) !== null && claudeHomeOf(targetKey) !== null;

/** Claude Code's project folder for a cwd; it shortens paths over 200 characters with a hash. */
export const claudeProjectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export const CARRY_FALLBACK_NOTICE = "Couldn't carry the session over; continued from a summary.";

export const CARRY_WORKFLOW_NOTE =
  "Note: this conversation moved to another Claude account, together with its workflow journals. Resume each workflow that did not finish with the Workflow tool's resumeFromRunId and its scriptPath instead of starting it over.";

/** The line a turn shows when it continues from a summary instead of the carried session. */
export const fallbackNoticeEvent = (input: {
  readonly id: EventId;
  readonly itemId: TurnItemId;
  readonly run: Pick<
    OrchestrationV2Run,
    "id" | "threadId" | "rootNodeId" | "providerThreadId" | "providerInstanceId"
  >;
  readonly occurredAt: DateTime.Utc;
}): OrchestrationV2DomainEvent => ({
  id: input.id,
  type: "turn-item.updated",
  threadId: input.run.threadId,
  runId: input.run.id,
  ...(input.run.rootNodeId === null ? {} : { nodeId: input.run.rootNodeId }),
  providerInstanceId: input.run.providerInstanceId,
  occurredAt: input.occurredAt,
  payload: {
    id: input.itemId,
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.run.rootNodeId,
    providerThreadId: input.run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    // The event sink places the line after the run's existing items.
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: input.occurredAt,
    completedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    type: "system_notice",
    message: CARRY_FALLBACK_NOTICE,
  },
});

export type SessionCarry =
  | { readonly type: "none" }
  | { readonly type: "carried"; readonly note: string }
  | { readonly type: "fallback"; readonly reason: string };

const NONE = { type: "none" } as const;
export const noCarry: SessionCarry = NONE;

type CarryAttempt = Pick<
  OrchestrationV2RunAttempt,
  "id" | "runId" | "providerInstanceId" | "nativeThreadId" | "startedAt"
>;
type CarryRun = Pick<
  OrchestrationV2Run,
  "id" | "status" | "activeAttemptId" | "providerInstanceId"
>;

export type CarryPlan<Run extends CarryRun = CarryRun> =
  | { readonly type: "none" }
  | { readonly type: "copy"; readonly from: ProviderInstanceId }
  | {
      readonly type: "check_first_turn";
      readonly run: Run;
      readonly movedFrom: ProviderInstanceId;
    };

/**
 * The live copy is on the account where the session last ran. A failed first turn after a move
 * may mean the new account cannot continue the session, so it is checked before resuming again.
 */
export function planCarry<Run extends CarryRun>(input: {
  readonly attempts: ReadonlyArray<CarryAttempt>;
  readonly runs: ReadonlyArray<Run>;
  readonly run: CarryRun;
  readonly providerThread: Pick<OrchestrationV2ProviderThread, "nativeThreadRef">;
}): CarryPlan<Run> {
  const sessionId = input.providerThread.nativeThreadRef?.nativeId;
  if (sessionId == null) return NONE;
  const ran = input.attempts
    .filter(
      (attempt): attempt is CarryAttempt & { readonly startedAt: DateTime.Utc } =>
        attempt.id !== input.run.activeAttemptId &&
        attempt.startedAt !== null &&
        attempt.nativeThreadId === sessionId,
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.startedAt) - DateTime.toEpochMillis(right.startedAt),
    );
  const last = ran.at(-1);
  if (last === undefined) return NONE;
  if (last.providerInstanceId !== input.run.providerInstanceId) {
    return { type: "copy", from: last.providerInstanceId };
  }
  const before = ran.at(-2);
  const lastRun = input.runs.find((candidate) => candidate.id === last.runId);
  return before !== undefined &&
    before.providerInstanceId !== last.providerInstanceId &&
    lastRun?.status === "failed" &&
    lastRun.activeAttemptId === last.id
    ? { type: "check_first_turn", run: lastRun, movedFrom: before.providerInstanceId }
    : NONE;
}

/** Session folders reach gigabytes, so files are compared a chunk at a time and never read whole. */
export const CARRY_CHUNK_BYTES = 1024 * 1024;

const sameStart = Effect.fn("ClaudeSessionCarry.sameStart")(function* (
  left: string,
  right: string,
  length: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const leftFile = yield* fileSystem.open(left);
  const rightFile = yield* fileSystem.open(right);
  const leftChunk = new Uint8Array(Math.min(CARRY_CHUNK_BYTES, length));
  const rightChunk = new Uint8Array(leftChunk.length);
  for (let position = 0; position < length;) {
    const size = Math.min(leftChunk.length, length - position);
    const options = { position: BigInt(position) };
    const leftRead = yield* leftFile.read(leftChunk.subarray(0, size), options);
    const rightRead = yield* rightFile.read(rightChunk.subarray(0, size), options);
    const read = Math.min(leftRead, rightRead);
    if (read === 0) return false;
    for (let index = 0; index < read; index += 1) {
      if (leftChunk[index] !== rightChunk[index]) return false;
    }
    position += read;
  }
  return true;
}, Effect.scoped);

export type CopyResult =
  | {
      readonly type: "copied";
      readonly hasWorkflows: boolean;
      readonly files: number;
      readonly bytes: number;
    }
  | { readonly type: "failed"; readonly reason: string };

/**
 * Copies `<id>.jsonl` and `<id>/` (subagents, workflows, tool results) between Claude homes. Logs
 * (`.jsonl`) only grow, so a stale target copy is replaced only when each of its logs is a byte
 * prefix of the live one and it has no file the live copy lacks; otherwise it was written to
 * after it went stale. Claude rewrites state files such as `workflows/<run>.json` in place.
 */
export const copySession = Effect.fn("ClaudeSessionCarry.copySession")(
  function* (input: {
    readonly sourceHome: string;
    readonly targetHome: string;
    readonly sessionId: string;
    readonly cwd: string | null;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const failed = (reason: string): CopyResult => ({ type: "failed", reason });
    const transcript = `${input.sessionId}.jsonl`;
    const sourceProjects = path.join(input.sourceHome, "projects");
    const preferred = input.cwd === null ? null : claudeProjectFolder(input.cwd);
    const folder =
      preferred !== null &&
      (yield* fileSystem.exists(path.join(sourceProjects, preferred, transcript)))
        ? preferred
        : yield* Effect.gen(function* () {
            if (!(yield* fileSystem.exists(sourceProjects))) return null;
            const holders: Array<string> = [];
            for (const candidate of yield* fileSystem.readDirectory(sourceProjects)) {
              if (yield* fileSystem.exists(path.join(sourceProjects, candidate, transcript))) {
                holders.push(candidate);
              }
            }
            return holders.length === 1 ? holders[0]! : null;
          });
    if (folder === null) return failed("the old account holds no single copy of the session");

    const sourceFolder = path.join(sourceProjects, folder);
    const targetFolder = path.join(input.targetHome, "projects", folder);
    const sizeOf = (file: string) =>
      fileSystem.stat(file).pipe(Effect.map((info) => Number(info.size)));
    const listFiles = Effect.fn("ClaudeSessionCarry.listFiles")(function* (root: string) {
      const sizes = new Map<string, number>();
      if (yield* fileSystem.exists(path.join(root, transcript))) {
        sizes.set(transcript, yield* sizeOf(path.join(root, transcript)));
      }
      const directory = path.join(root, input.sessionId);
      if (!(yield* fileSystem.exists(directory))) return sizes;
      for (const entry of yield* fileSystem.readDirectory(directory, { recursive: true })) {
        const info = yield* fileSystem.stat(path.join(directory, entry));
        if (info.type === "File") sizes.set(path.join(input.sessionId, entry), Number(info.size));
      }
      return sizes;
    });
    const live = yield* listFiles(sourceFolder);
    const stale = yield* listFiles(targetFolder);
    for (const [file, staleSize] of stale) {
      const liveSize = live.get(file);
      if (
        liveSize === undefined ||
        (file.endsWith(".jsonl") &&
          (staleSize > liveSize ||
            !(yield* sameStart(
              path.join(targetFolder, file),
              path.join(sourceFolder, file),
              staleSize,
            ))))
      ) {
        return failed(`the new account's copy of ${file} differs from the live session`);
      }
    }
    const writes: Array<string> = [];
    for (const [file, size] of live) {
      const unchanged =
        stale.get(file) === size &&
        (file.endsWith(".jsonl") ||
          (yield* sameStart(path.join(targetFolder, file), path.join(sourceFolder, file), size)));
      if (!unchanged) writes.push(file);
    }
    // The transcript goes last: a resume finds it only once its directory is complete.
    writes.sort((left, right) => Number(left === transcript) - Number(right === transcript));
    const copied = new Map(live);
    let bytes = 0;
    for (const file of writes) {
      const target = path.join(targetFolder, file);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.copyFile(path.join(sourceFolder, file), `${target}.t3-carry`);
      const size = yield* sizeOf(`${target}.t3-carry`);
      yield* fileSystem.rename(`${target}.t3-carry`, target);
      copied.set(file, size);
      bytes += size;
    }
    for (const [file, size] of copied) {
      if ((yield* sizeOf(path.join(sourceFolder, file))) !== size) {
        return failed(`the old account was still writing ${file}`);
      }
    }
    return {
      type: "copied",
      hasWorkflows: [...live.keys()].some(
        (file) =>
          file.startsWith(path.join(input.sessionId, "subagents", "workflows")) ||
          file.startsWith(path.join(input.sessionId, "workflows")),
      ),
      files: writes.length,
      bytes,
    } satisfies CopyResult;
  },
  Effect.catch((error) =>
    Effect.succeed<CopyResult>({ type: "failed", reason: `copying failed: ${error.message}` }),
  ),
);

export interface ClaudeSessionCarryShape {
  /** Readies the session a turn resumes on a Claude account it moved to. */
  readonly prepareResume: (input: {
    readonly threadId: ThreadId;
    readonly projection: {
      readonly runs: ReadonlyArray<OrchestrationV2Run>;
      readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
      readonly providerSessions: ReadonlyArray<OrchestrationV2ProviderSession>;
    };
    readonly run: OrchestrationV2Run;
    readonly providerThread: Pick<OrchestrationV2ProviderThread, "nativeThreadRef">;
    readonly cwd: string | null;
  }) => Effect.Effect<SessionCarry>;
}

export class ClaudeSessionCarry extends Context.Service<
  ClaudeSessionCarry,
  ClaudeSessionCarryShape
>()("t3/orchestration-v2/ClaudeSessionCarry") {}

export const layer = Layer.effect(
  ClaudeSessionCarry,
  Effect.gen(function* () {
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const homeOf = (instanceId: ProviderInstanceId) =>
      adapters.getMetadata === undefined
        ? Effect.succeed(null)
        : adapters.getMetadata(instanceId).pipe(
            Effect.map((metadata) => claudeHomeOf(metadata.continuationKey)),
            Effect.orElseSucceed(() => null),
          );
    // Both accounts are Claude homes and differ; otherwise there is nothing to copy.
    const distinctHomes = Effect.fn("ClaudeSessionCarry.distinctHomes")(function* (
      from: ProviderInstanceId,
      to: ProviderInstanceId,
    ) {
      const source = yield* homeOf(from);
      const target = yield* homeOf(to);
      return source === null || target === null || source === target ? null : { source, target };
    });

    const prepareResume: ClaudeSessionCarryShape["prepareResume"] = Effect.fn(
      "ClaudeSessionCarry.prepareResume",
    )(
      function* (input) {
        const plan = planCarry({
          attempts: input.projection.attempts,
          runs: input.projection.runs,
          run: input.run,
          providerThread: input.providerThread,
        });
        const sessionId = input.providerThread.nativeThreadRef?.nativeId;
        if (plan.type === "none" || sessionId == null) return noCarry;
        const fallback = (reason: string) =>
          Effect.logWarning("Could not carry the Claude session to the new account", {
            threadId: input.threadId,
            runId: input.run.id,
            reason,
          }).pipe(Effect.as<SessionCarry>({ type: "fallback", reason }));

        if (plan.type === "check_first_turn") {
          if ((yield* distinctHomes(plan.movedFrom, plan.run.providerInstanceId)) === null) {
            return noCarry;
          }
          const { turnItems } = yield* projectionStore.getThreadRecords(
            input.threadId,
            ["turnItems"],
            { turnItemTypes: ["error"], turnItemRunIds: [plan.run.id] },
          );
          return latestRootProviderFailure(plan.run, turnItems)?.class === "usage_limit"
            ? noCarry
            : yield* fallback("the first turn after the move failed");
        }

        const homes = yield* distinctHomes(plan.from, input.run.providerInstanceId);
        if (homes === null) return noCarry;
        for (const session of input.projection.providerSessions) {
          if (session.providerInstanceId === plan.from && (yield* sessions.isLive(session.id))) {
            return yield* fallback("the old account's Claude process is still running");
          }
        }
        const [duration, copied] = yield* copySession({
          sourceHome: homes.source,
          targetHome: homes.target,
          sessionId,
          cwd: input.cwd,
        }).pipe(Effect.provide(services), Effect.timed);
        if (copied.type === "failed") return yield* fallback(copied.reason);
        yield* Effect.logInfo("Carried the Claude session to the new account", {
          threadId: input.threadId,
          runId: input.run.id,
          files: copied.files,
          bytes: copied.bytes,
          durationMs: Duration.toMillis(duration),
        });
        return { type: "carried", note: copied.hasWorkflows ? CARRY_WORKFLOW_NOTE : "" } as const;
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not carry the Claude session to the new account", { cause }).pipe(
          Effect.as<SessionCarry>({ type: "fallback", reason: "carrying the session failed" }),
        ),
      ),
    );

    return ClaudeSessionCarry.of({ prepareResume });
  }),
);
