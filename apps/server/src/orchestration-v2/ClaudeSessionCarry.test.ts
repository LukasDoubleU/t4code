import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { makeClaudeContinuationGroupKey } from "../provider/Drivers/ClaudeHome.ts";
import * as ClaudeSessionCarry from "./ClaudeSessionCarry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const accountA = ProviderInstanceId.make("claude-a");
const accountB = ProviderInstanceId.make("claude-b");
const threadId = ThreadId.make("thread:carry");
const providerThreadId = ProviderThreadId.make("provider-thread:carry");
const sessionId = "0b5e7a52-3f4d-4c39-9f0e-5d8f9c1a2b3c";
const cwd = "/home/user/acme.app/feature_x";

const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);

const attempt = (
  id: string,
  instanceId: ProviderInstanceId,
  startedAt: number | null,
  nativeThreadId: string | undefined = sessionId,
): OrchestrationV2RunAttempt => ({
  id: RunAttemptId.make(`attempt:${id}`),
  runId: RunId.make(`run:${id.split(".")[0]}`),
  attemptOrdinal: 1,
  rootNodeId: NodeId.make(`node:${id}`),
  providerInstanceId: instanceId,
  providerThreadId,
  providerTurnId: null,
  reason: "initial",
  status: "completed",
  startedAt: startedAt === null ? null : at(startedAt),
  completedAt: null,
  ...(nativeThreadId === undefined ? {} : { nativeThreadId }),
});

const run = (
  id: string,
  instanceId: ProviderInstanceId,
  status: OrchestrationV2Run["status"] = "completed",
) =>
  ({
    id: RunId.make(`run:${id}`),
    status,
    activeAttemptId: RunAttemptId.make(`attempt:${id}`),
    providerInstanceId: instanceId,
    rootNodeId: NodeId.make(`node:${id}`),
  }) as OrchestrationV2Run;

const providerThread = {
  id: providerThreadId,
  nativeThreadRef: { driver: CLAUDE, nativeId: sessionId, strength: "strong" as const },
};

describe("planCarry", () => {
  it.each([
    {
      name: "copies from the account the session last ran on",
      attempts: [attempt("1", accountA, 1), attempt("2", accountA, 2)],
      runs: [run("1", accountA), run("2", accountA)],
      expected: { type: "copy", from: accountA },
    },
    {
      // A turn restarted on another account mid-turn ran its earlier attempt on the old one.
      name: "counts an earlier attempt of the starting run",
      attempts: [attempt("1", accountB, 1), attempt("3.0", accountA, 3)],
      runs: [run("1", accountB)],
      expected: { type: "copy", from: accountA },
    },
    {
      name: "copies nothing when the session last ran on the starting account",
      attempts: [attempt("1", accountA, 1), attempt("2", accountB, 2)],
      runs: [run("1", accountA), run("2", accountB)],
      expected: { type: "none" },
    },
    {
      name: "ignores attempts that never started or ran another session",
      attempts: [attempt("1", accountA, null), attempt("2", accountA, 2, "other-session")],
      runs: [run("1", accountA), run("2", accountA)],
      expected: { type: "none" },
    },
    {
      name: "checks a failed first turn after a move",
      attempts: [attempt("1", accountA, 1), attempt("2", accountB, 2)],
      runs: [run("1", accountA), run("2", accountB, "failed")],
      expected: { type: "check_first_turn", runId: RunId.make("run:2"), movedFrom: accountA },
    },
  ] as const)("$name", ({ attempts, runs, expected }) => {
    const plan = ClaudeSessionCarry.planCarry({
      attempts,
      runs,
      run: run("3", accountB),
      providerThread,
    });
    assert.deepEqual(
      plan.type === "check_first_turn"
        ? { type: plan.type, runId: plan.run.id, movedFrom: plan.movedFrom }
        : plan,
      expected,
    );
  });
});

const writeFiles = Effect.fn("writeFiles")(function* (
  root: string,
  files: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, content);
  }
});

const readTree = Effect.fn("readTree")(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fileSystem.exists(root))) return {};
  const tree: Record<string, string> = {};
  for (const entry of (yield* fileSystem.readDirectory(root, { recursive: true })).toSorted()) {
    const file = path.join(root, entry);
    if ((yield* fileSystem.stat(file)).type === "File") {
      tree[entry] = yield* fileSystem.readFileString(file);
    }
  }
  return tree;
});

const folder = ClaudeSessionCarry.claudeProjectFolder(cwd);
const liveSession = {
  [`projects/${folder}/${sessionId}.jsonl`]: '{"type":"user"}\n{"type":"assistant"}\n',
  [`projects/${folder}/${sessionId}/subagents/workflows/wf_1/journal.jsonl`]: "agent-1 done\n",
  [`projects/${folder}/${sessionId}/workflows/scripts/review.js`]: "export default 1\n",
  [`projects/${folder}/${sessionId}/workflows/wf_1.json`]: '{"status":"done"}',
  [`projects/${folder}/${sessionId}/tool-results/out.txt`]: "output\n",
};

it.layer(NodeServices.layer)("copySession", (it) => {
  it.effect("names the cwd's folder the way Claude Code does", () =>
    Effect.sync(() => {
      assert.equal(folder, "-home-user-acme-app-feature-x");
    }),
  );

  it.effect.each([
    {
      name: "copies the session and its folder, leaving the original untouched",
      source: liveSession,
      target: {},
      expected: { type: "copied", hasWorkflows: true },
    },
    {
      name: "overwrites a stale snapshot that is a byte prefix of the live session",
      source: liveSession,
      target: {
        [`projects/${folder}/${sessionId}.jsonl`]: '{"type":"user"}\n',
        [`projects/${folder}/${sessionId}/subagents/workflows/wf_1/journal.jsonl`]: "agent-1",
      },
      expected: { type: "copied", hasWorkflows: true },
    },
    {
      // Claude Code rewrites a workflow's state file in place; only the logs only grow.
      name: "replaces a rewritten state file of the same length",
      source: liveSession,
      target: { [`projects/${folder}/${sessionId}/workflows/wf_1.json`]: '{"status":"busy"}' },
      expected: { type: "copied", hasWorkflows: true },
    },
    {
      name: "finds the session in a shortened folder when only one holds it",
      source: {
        [`projects/-long-folder-12ab/${sessionId}.jsonl`]: '{"type":"user"}\n',
      },
      target: {},
      expected: { type: "copied", hasWorkflows: false },
    },
    {
      name: "refuses a stale session file that is not a prefix",
      source: liveSession,
      target: { [`projects/${folder}/${sessionId}.jsonl`]: '{"type":"user"}\n{"type":"other"}\n' },
      expected: { type: "failed" },
    },
    {
      name: "refuses a stale folder file that is not a prefix",
      source: liveSession,
      target: {
        [`projects/${folder}/${sessionId}/subagents/workflows/wf_1/journal.jsonl`]: "agent-2",
      },
      expected: { type: "failed" },
    },
    {
      name: "refuses a stale snapshot with a file the live session lacks",
      source: liveSession,
      target: { [`projects/${folder}/${sessionId}/tool-results/extra.txt`]: "written later\n" },
      expected: { type: "failed" },
    },
    {
      name: "fails when the old account has no copy of the session",
      source: {},
      target: {},
      expected: { type: "failed" },
    },
  ])("$name", ({ source, target, expected }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-carry-" });
      const sourceHome = path.join(root, "a");
      const targetHome = path.join(root, "b");
      yield* writeFiles(sourceHome, source);
      yield* writeFiles(targetHome, target);

      const result = yield* ClaudeSessionCarry.copySession({
        sourceHome,
        targetHome,
        sessionId,
        cwd,
      });

      assert.deepEqual(result.type === "failed" ? { type: result.type } : result, expected);
      assert.deepEqual(yield* readTree(sourceHome), source);
      assert.deepEqual(
        yield* readTree(targetHome),
        result.type === "copied" ? { ...target, ...source } : target,
      );
    }).pipe(Effect.scoped),
  );
});

const sourceSession = (status: OrchestrationV2ProviderSession["status"]) =>
  ({
    id: ProviderSessionId.make("provider-session:a"),
    providerInstanceId: accountA,
    status,
  }) as OrchestrationV2ProviderSession;

const prepare = Effect.fn("prepare")(function* (input: {
  readonly keys: Readonly<Record<string, string>>;
  readonly liveSessions?: ReadonlyArray<string>;
  readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly source?: Readonly<Record<string, string>>;
  readonly failureClass?: "usage_limit" | "provider_error";
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-carry-" });
  const homes = { a: path.join(root, "a"), b: path.join(root, "b") };
  yield* writeFiles(homes.a, input.source ?? liveSession);
  const failedRun = input.runs.find((candidate) => candidate.status === "failed");
  const now = yield* DateTime.now;
  const carry = yield* ClaudeSessionCarry.ClaudeSessionCarry.pipe(
    Effect.provide(
      ClaudeSessionCarry.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              getMetadata: (instanceId) =>
                Effect.succeed({
                  driver: CLAUDE,
                  continuationKey: (input.keys[instanceId] ?? "").replace(
                    /\{(a|b)\}/,
                    (_match, home: "a" | "b") => homes[home],
                  ),
                  enabled: true,
                  capabilities: {} as never,
                }),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              isLive: (id) => Effect.succeed(input.liveSessions?.includes(id) ?? false),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  turnItems:
                    failedRun === undefined || input.failureClass === undefined
                      ? []
                      : [
                          {
                            id: TurnItemId.make("turn-item:error"),
                            type: "error",
                            status: "failed",
                            runId: failedRun.id,
                            nodeId: failedRun.rootNodeId,
                            ordinal: 1,
                            updatedAt: now,
                            failure: makeProviderFailure({
                              message: "failed",
                              class: input.failureClass,
                            }),
                          },
                        ],
                } as never),
            }),
          ),
        ),
      ),
    ),
  );
  const result = yield* carry.prepareResume({
    threadId,
    projection: {
      runs: input.runs,
      attempts: input.attempts,
      providerSessions: [sourceSession("ready")],
    },
    run: run("3", accountB),
    providerThread,
    cwd,
  });
  return { result, target: yield* readTree(homes.b) };
});

const claudeHomes = { [accountA]: "claude:home:{a}", [accountB]: "claude:home:{b}" };
const movedFromA = {
  attempts: [attempt("1", accountA, 1)],
  runs: [run("1", accountA)],
};

it.layer(NodeServices.layer)("prepareResume", (it) => {
  it.effect("carries a session between two Claude homes and asks to resume workflows", () =>
    Effect.gen(function* () {
      const { result, target } = yield* prepare({ keys: claudeHomes, ...movedFromA });
      assert.equal(result.type, "carried");
      assert.include(result.type === "carried" ? result.note : "", "resumeFromRunId");
      assert.lengthOf(Object.keys(target), Object.keys(liveSession).length);
    }).pipe(Effect.scoped),
  );

  it.effect("adds no note to a session without workflows", () =>
    Effect.gen(function* () {
      const { result } = yield* prepare({
        keys: claudeHomes,
        ...movedFromA,
        source: { [`projects/${folder}/${sessionId}.jsonl`]: '{"type":"user"}\n' },
      });
      assert.deepEqual(result, { type: "carried", note: "" });
    }).pipe(Effect.scoped),
  );

  it.effect("copies nothing while the old account's session is still live", () =>
    Effect.gen(function* () {
      const { result, target } = yield* prepare({
        keys: claudeHomes,
        liveSessions: ["provider-session:a"],
        ...movedFromA,
      });
      assert.equal(result.type, "fallback");
      assert.deepEqual(target, {});
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "a shared home",
      keys: { [accountA]: "claude:home:{a}", [accountB]: "claude:home:{a}" },
    },
    {
      name: "another driver's accounts",
      keys: { [accountA]: "codex:home:{a}", [accountB]: "codex:home:{b}" },
    },
  ])("leaves the resume alone between $name", ({ keys }) =>
    Effect.gen(function* () {
      const { result, target } = yield* prepare({ keys, ...movedFromA });
      assert.deepEqual(result, { type: "none" });
      assert.deepEqual(target, {});
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { failureClass: "provider_error", expected: "fallback" },
    { failureClass: "usage_limit", expected: "none" },
  ] as const)(
    "after a failed first turn on the new account ($failureClass): $expected",
    ({ failureClass, expected }) =>
      Effect.gen(function* () {
        const { result } = yield* prepare({
          keys: claudeHomes,
          attempts: [attempt("1", accountA, 1), attempt("2", accountB, 2)],
          runs: [run("1", accountA), run("2", accountB, "failed")],
          failureClass,
        });
        assert.equal(result.type, expected);
      }).pipe(Effect.scoped),
  );

  it.effect("reads the home from a Claude continuation key", () =>
    Effect.gen(function* () {
      const key = yield* makeClaudeContinuationGroupKey({ homePath: "/home/user/.claude-two" });
      assert.equal(ClaudeSessionCarry.claudeHomeOf(key), "/home/user/.claude-two");
    }),
  );
});
