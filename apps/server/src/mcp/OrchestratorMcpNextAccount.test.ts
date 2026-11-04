import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpProviderCapability,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  ThreadId,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

// The test clock starts at the epoch.
const HOUR = 3_600_000;
const inHours = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(hours * HOUR));
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:next-account"),
  requestNamespace: "client:next-account",
  thread: undefined,
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function windows(sessionUsed: number, weeklyUsed: number, weeklyResetsInHours: number) {
  return [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: sessionUsed,
      windowDurationMins: 300,
      resetsAt: inHours(2),
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyUsed,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: inHours(weeklyResetsInHours),
    },
  ] satisfies ReadonlyArray<ServerProviderUsageWindow>;
}

function provider(
  instanceId: string,
  driver: ProviderDriverKind,
  email: string | null,
  usageWindows?: ReadonlyArray<ServerProviderUsageWindow>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated", ...(email === null ? {} : { email }) },
    checkedAt: inHours(0),
    models: [],
    slashCommands: [],
    skills: [],
    ...(usageWindows === undefined
      ? {}
      : { usageLimits: { checkedAt: inHours(0), windows: usageWindows } }),
  };
}

const providers = [
  provider("claude-roomy", claude, "roomy@example.com", windows(10, 10, 150)),
  provider("claude-roomy-copy", claude, "roomy@example.com", windows(10, 10, 150)),
  provider("claude-urgent", claude, "urgent@example.com", windows(10, 40, 24)),
  provider("claude-api", claude, null),
  provider("codex", codex, "codex@example.com", windows(10, 10, 24)),
];

// Snapshot instances come from settings; only the codex and claudeAgent defaults run unconfigured.
const machineInstances = Object.fromEntries(
  providers.map((entry) => [entry.instanceId, { driver: entry.driver }]),
);

const callerIn = (projectId: ProjectId): McpInvocationScope => ({
  ...scope,
  thread: {
    threadId: ThreadId.make(`thread:${projectId}`),
    providerSessionId: "provider-session:next-account",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
});

const capabilitiesFor = (
  hubSnapshots: ReadonlyArray<UsageLimitSourceSnapshot> | null,
  caller: {
    readonly projectId?: ProjectId;
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  } = {},
) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const capabilities = yield* service.capabilities(
      caller.projectId === undefined ? scope : callerIn(caller.projectId),
    );
    return new Map(capabilities.providers.map((entry) => [entry.providerInstanceId, entry]));
  }).pipe(
    Effect.provide(
      OrchestratorMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: (threadId) =>
                Effect.succeed({
                  thread: {
                    id: threadId,
                    projectId: caller.projectId,
                    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
                    runtimeMode: "full-access",
                    interactionMode: "default",
                  },
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            ServerSettings.layerTest(caller.settings ?? { providerInstances: machineInstances }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(providers),
            }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed(providers.map((entry) => entry.instanceId)),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            hubSnapshots === null
              ? Layer.empty
              : Layer.mock(UsageLimitSources.UsageLimitSources)({
                  current: Effect.succeed(hubSnapshots),
                }),
          ),
        ),
      ),
    ),
  );

const nextAccountsFor = (hubSnapshots: ReadonlyArray<UsageLimitSourceSnapshot> | null) =>
  capabilitiesFor(hubSnapshots).pipe(
    Effect.map(
      (entries) =>
        new Map([...entries].map(([instanceId, entry]) => [instanceId, entry.nextAccount])),
    ),
  );

describe("orchestrator_capabilities next account", () => {
  it.effect("ranks this environment's accounts per provider like Use next", () =>
    Effect.gen(function* () {
      const byInstance = yield* nextAccountsFor(null);
      assert.deepEqual(byInstance.get(ProviderInstanceId.make("claude-urgent")), {
        place: 1,
        recommended: true,
        reason: "Weekly: 60% left, resets in 1d 0h · 60%/day at risk",
      });
      // Two instances signed in to one account share its place.
      for (const id of ["claude-roomy", "claude-roomy-copy"]) {
        assert.deepInclude(byInstance.get(ProviderInstanceId.make(id)), {
          place: 2,
          recommended: false,
        });
      }
      assert.isUndefined(byInstance.get(ProviderInstanceId.make("claude-api")));
      assert.deepInclude(byInstance.get(ProviderInstanceId.make("codex")), {
        place: 1,
        recommended: true,
      });
    }),
  );

  it.effect("pools a fresher hub reading of the same account", () =>
    Effect.gen(function* () {
      const byInstance = yield* nextAccountsFor([
        {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy",
          label: "Hub",
          checkedAt: inHours(0.5),
          accounts: [
            {
              id: "urgent.json",
              driver: claude,
              email: "urgent@example.com",
              usageLimits: { checkedAt: inHours(0.5), windows: windows(90, 40, 24) },
            },
          ],
        },
      ]);
      assert.deepEqual(byInstance.get(ProviderInstanceId.make("claude-urgent")), {
        place: 2,
        recommended: false,
        reason: "Session: 10% left, below 25% until 1970-01-01T02:00:00.000Z",
      });
      assert.deepInclude(byInstance.get(ProviderInstanceId.make("claude-roomy")), {
        place: 1,
        recommended: true,
      });
    }),
  );

  it.effect("lists and ranks only the instances the caller's project allows", () =>
    Effect.gen(function* () {
      const projectA = ProjectId.make("project:a");
      const settings = {
        providerInstances: {
          ...machineInstances,
          "claude-roomy": { driver: claude, enabled: false },
        },
        projectSettingsOverrides: {
          [projectA]: {
            providerInstances: {
              "claude-roomy": { enabled: true },
              "claude-urgent": { enabled: false },
            },
          },
        },
      };
      const assertRefused = (entry: OrchestratorMcpProviderCapability | undefined) => {
        assert.deepInclude(entry, {
          canRunChildTask: false,
          canRunCrossProviderChildTask: false,
          constraints: ["Provider instance is disabled."],
        });
        assert.isUndefined(entry?.nextAccount);
      };

      const inA = yield* capabilitiesFor(null, { projectId: projectA, settings });
      assertRefused(inA.get(ProviderInstanceId.make("claude-urgent")));
      for (const id of ["claude-roomy", "claude-roomy-copy"]) {
        const entry = inA.get(ProviderInstanceId.make(id));
        assert.deepInclude(entry, { canRunChildTask: true, constraints: [] });
        assert.deepInclude(entry?.nextAccount, { place: 1, recommended: true });
      }

      const inB = yield* capabilitiesFor(null, {
        projectId: ProjectId.make("project:b"),
        settings,
      });
      assertRefused(inB.get(ProviderInstanceId.make("claude-roomy")));
      assert.deepInclude(inB.get(ProviderInstanceId.make("claude-urgent"))?.nextAccount, {
        place: 1,
        recommended: true,
      });
      // Its account still ranks through the copy that project B allows.
      assert.deepInclude(inB.get(ProviderInstanceId.make("claude-roomy-copy"))?.nextAccount, {
        place: 2,
        recommended: false,
      });
    }),
  );
});
