import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import {
  groupSidebarThreads,
  resolveSidebarStatusGroup,
  selectSidebarViewOptions,
  sidebarGroupingPatch,
  sidebarSortPatch,
  sortSidebarActiveThreads,
  type SidebarGrouping,
  type SidebarThreadSort,
} from "./Sidebar.viewOptions";

const SORTS: readonly SidebarThreadSort[] = ["manual", "last_message", "status"];
const GROUPINGS: readonly SidebarGrouping[] = ["none", "project", "machine", "status"];

const NOW = "2026-06-02T14:00:00.000Z";
const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");
const appProjectId = ProjectId.make("app");
const docsProjectId = ProjectId.make("docs");

function runtime(
  status: NonNullable<Thread["runtime"]>["status"],
  extra: Partial<NonNullable<Thread["runtime"]>> = {},
): NonNullable<Thread["runtime"]> {
  return {
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-06-02T07:00:00.000Z",
    ...extra,
  };
}

// A thread whose latest run finished at 09:05.
const finished = {
  latestRun: {
    runId: RunId.make("run-1"),
    status: "completed",
    requestedAt: "2026-06-02T09:00:00.000Z",
    startedAt: "2026-06-02T09:00:00.000Z",
    completedAt: "2026-06-02T09:05:00.000Z",
    assistantMessageId: null,
  },
  runtime: runtime("completed"),
} satisfies Partial<Thread>;

function thread(
  id: string,
  input: {
    readonly environmentId?: EnvironmentId;
    readonly projectId?: ProjectId;
    readonly lastMessageAt?: string;
    readonly activeOrderKey?: string;
  } & Partial<Thread> = {},
): Thread {
  const { environmentId, projectId, lastMessageAt, activeOrderKey, ...overrides } = input;
  return makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: environmentId ?? localEnvironmentId,
    projectId: projectId ?? appProjectId,
    ...(lastMessageAt === undefined ? {} : { latestUserMessageAt: lastMessageAt }),
    activeOrderKey: activeOrderKey ?? null,
    ...overrides,
  });
}

const statusGroupOf = (entry: Thread) =>
  resolveSidebarStatusGroup(entry, { now: NOW, localLastVisitedAt: undefined });

describe("selectSidebarViewOptions", () => {
  const settings = (overrides: Partial<ClientSettings> = {}) => ({
    ...DEFAULT_CLIENT_SETTINGS,
    ...overrides,
  });

  it("keeps today's sidebar for clients that never chose", () => {
    expect(selectSidebarViewOptions(settings())).toEqual({ sort: "manual", grouping: "none" });
  });

  it("shows project folders while the boring sidebar switch or the legacy opt-in is on", () => {
    for (const sidebarThreadGrouping of ["none", "machine", "status"] as const) {
      expect(
        selectSidebarViewOptions(settings({ boringSidebarEnabled: true, sidebarThreadGrouping }))
          .grouping,
      ).toBe("project");
      expect(
        selectSidebarViewOptions(settings({ legacySidebarEnabled: true, sidebarThreadGrouping }))
          .grouping,
      ).toBe("project");
    }
  });

  it("puts a status sort ahead of the last-message sort", () => {
    expect(selectSidebarViewOptions(settings({ sidebarSortByLastMessage: true })).sort).toBe(
      "last_message",
    );
    expect(
      selectSidebarViewOptions(
        settings({ sidebarSortByLastMessage: true, sidebarSortByStatus: true }),
      ).sort,
    ).toBe("status");
  });

  it.each(SORTS.flatMap((sort) => GROUPINGS.map((grouping) => [sort, grouping] as const)))(
    "stores sort %s with grouping %s, whatever was chosen before",
    (sort, grouping) => {
      const starts = [
        settings(),
        settings({ legacySidebarEnabled: true, sidebarSortByStatus: true }),
        settings({
          boringSidebarEnabled: true,
          sidebarSortByLastMessage: true,
          sidebarThreadGrouping: "status",
        }),
        settings({ sidebarThreadGrouping: "machine", sidebarSortByStatus: true }),
      ];
      for (const start of starts) {
        const sorted = { ...start, ...sidebarSortPatch(sort) };
        const chosen = { ...sorted, ...sidebarGroupingPatch(grouping) };
        expect(selectSidebarViewOptions(chosen)).toEqual({ sort, grouping });
        // Either order of the two choices lands on the same view.
        const grouped = { ...start, ...sidebarGroupingPatch(grouping) };
        expect(selectSidebarViewOptions({ ...grouped, ...sidebarSortPatch(sort) })).toEqual({
          sort,
          grouping,
        });
      }
    },
  );

  it("writes project folders and the last-message sort to the settings they already had", () => {
    expect(sidebarGroupingPatch("project")).toEqual({
      boringSidebarEnabled: true,
      legacySidebarEnabled: false,
      sidebarThreadGrouping: "none",
    });
    expect(sidebarGroupingPatch("machine")).toMatchObject({
      boringSidebarEnabled: false,
      sidebarThreadGrouping: "machine",
    });
    expect(sidebarSortPatch("last_message")).toEqual({
      sidebarSortByLastMessage: true,
      sidebarSortByStatus: false,
    });
  });
});

describe("resolveSidebarStatusGroup", () => {
  it("puts questions and approvals first, including a subagent's", () => {
    expect(statusGroupOf(thread("approval", { hasPendingApprovals: true }))).toBe("needs_you");
    expect(statusGroupOf(thread("input", { hasPendingUserInput: true }))).toBe("needs_you");
    expect(statusGroupOf(thread("subagent", { pendingSubagentRequest: "user_input" }))).toBe(
      "needs_you",
    );
    expect(
      statusGroupOf(
        thread("asks-while-running", { hasPendingApprovals: true, runtime: runtime("running") }),
      ),
    ).toBe("needs_you");
  });

  it("counts a usage limit as failed and background waiting as working", () => {
    expect(statusGroupOf(thread("failed", { runtime: runtime("failed") }))).toBe("failed");
    expect(
      statusGroupOf(
        thread("limited", { runtime: runtime("failed", { lastErrorClass: "usage_limit" }) }),
      ),
    ).toBe("failed");
    expect(statusGroupOf(thread("running", { runtime: runtime("running") }))).toBe("working");
    expect(statusGroupOf(thread("queued", { runtime: runtime("queued") }))).toBe("working");
    expect(statusGroupOf(thread("waiting", { runtime: runtime("idle") }))).toBe("working");
  });

  it("calls finished work completed until it is visited, then idle", () => {
    const unread = thread("unread", { ...finished, lastVisitedAt: "2026-06-02T09:01:00.000Z" });
    const seen = thread("seen", { ...finished, lastVisitedAt: NOW });
    expect(statusGroupOf(unread)).toBe("completed");
    expect(statusGroupOf(seen)).toBe("idle");
    expect(statusGroupOf(thread("new"))).toBe("idle");
  });

  it("uses the browser's visit for servers that do not track visits", () => {
    const untracked = thread("untracked", finished);
    expect(
      resolveSidebarStatusGroup(untracked, {
        now: NOW,
        localLastVisitedAt: "2026-06-02T09:01:00.000Z",
      }),
    ).toBe("completed");
    expect(resolveSidebarStatusGroup(untracked, { now: NOW, localLastVisitedAt: NOW })).toBe(
      "idle",
    );
  });

  it("brings a woken snooze to the user until they open it", () => {
    const woke = {
      snoozedAt: "2026-06-02T04:00:00.000Z",
      snoozedUntil: "2026-06-02T05:00:00.000Z",
    };
    expect(
      statusGroupOf(thread("woke", { ...woke, lastVisitedAt: "2026-06-02T04:00:00.000Z" })),
    ).toBe("needs_you");
    expect(statusGroupOf(thread("opened", { ...woke, lastVisitedAt: NOW }))).toBe("idle");
    expect(
      statusGroupOf(
        thread("still-snoozed", {
          snoozedAt: "2026-06-02T04:00:00.000Z",
          snoozedUntil: "2026-06-03T05:00:00.000Z",
          lastVisitedAt: "2026-06-02T04:00:00.000Z",
        }),
      ),
    ).toBe("idle");
  });
});

describe("sorting and grouping threads", () => {
  // Machine order follows the label, after the machine the sidebar runs on.
  const machines = [
    { environmentId: remoteEnvironmentId, label: "Build box" },
    { environmentId: localEnvironmentId, label: "Workstation" },
  ];
  const projectGroups = [
    { projectKey: "app", projectId: appProjectId, workspaceRoot: "/code/app" },
    { projectKey: "docs", projectId: docsProjectId, workspaceRoot: "/code/docs" },
  ].map((group) => ({
    projectKey: group.projectKey,
    memberProjectRefs: [localEnvironmentId, remoteEnvironmentId].map((environmentId) => ({
      environmentId,
      projectId: group.projectId,
    })),
    memberProjects: [
      { physicalProjectKey: `local:${group.workspaceRoot}`, workspaceRoot: group.workspaceRoot },
    ],
  }));
  const active = [
    thread("approval", {
      hasPendingApprovals: true,
      lastMessageAt: "2026-06-02T10:00:00.000Z",
      activeOrderKey: "e",
    }),
    thread("failed", {
      environmentId: remoteEnvironmentId,
      projectId: docsProjectId,
      runtime: runtime("failed"),
      lastMessageAt: "2026-06-02T11:00:00.000Z",
      activeOrderKey: "d",
    }),
    thread("working", {
      projectId: docsProjectId,
      runtime: runtime("running"),
      lastMessageAt: "2026-06-02T12:00:00.000Z",
      activeOrderKey: "a",
    }),
    thread("done", {
      environmentId: remoteEnvironmentId,
      ...finished,
      lastVisitedAt: "2026-06-02T09:01:00.000Z",
      lastMessageAt: "2026-06-02T09:00:00.000Z",
      activeOrderKey: "f",
    }),
    thread("idle", {
      ...finished,
      lastVisitedAt: NOW,
      lastMessageAt: "2026-06-02T13:00:00.000Z",
      activeOrderKey: "c",
    }),
    thread("input", {
      environmentId: remoteEnvironmentId,
      hasPendingUserInput: true,
      lastMessageAt: "2026-06-02T08:00:00.000Z",
      activeOrderKey: "b",
    }),
  ];
  const settled = [thread("settled", { environmentId: remoteEnvironmentId })];

  const arrange = (sort: SidebarThreadSort, grouping: SidebarGrouping) => {
    const sorted = sortSidebarActiveThreads(active, sort, statusGroupOf);
    if (grouping === "none") return sorted.map((entry) => entry.id);
    return groupSidebarThreads({
      grouping,
      projectGroups,
      machines,
      primaryEnvironmentId: localEnvironmentId,
      inbox: sorted,
      settled,
      statusGroupOf,
    }).map((folder) => ({
      key: folder.key,
      inbox: folder.inbox.map((entry) => entry.id),
      settled: folder.settled.map((entry) => entry.id),
    }));
  };

  const expected: Record<SidebarThreadSort, Record<SidebarGrouping, unknown>> = {
    manual: {
      none: ["working", "input", "idle", "failed", "approval", "done"],
      project: [
        { key: "app", inbox: ["input", "idle", "approval", "done"], settled: ["settled"] },
        { key: "docs", inbox: ["working", "failed"], settled: [] },
      ],
      machine: [
        {
          key: `sidebar-machine:${localEnvironmentId}`,
          inbox: ["working", "idle", "approval"],
          settled: [],
        },
        {
          key: `sidebar-machine:${remoteEnvironmentId}`,
          inbox: ["input", "failed", "done"],
          settled: ["settled"],
        },
      ],
      status: [
        { key: "sidebar-status:needs_you", inbox: ["input", "approval"], settled: [] },
        { key: "sidebar-status:failed", inbox: ["failed"], settled: [] },
        { key: "sidebar-status:working", inbox: ["working"], settled: [] },
        { key: "sidebar-status:completed", inbox: ["done"], settled: [] },
        { key: "sidebar-status:idle", inbox: ["idle"], settled: [] },
      ],
    },
    last_message: {
      none: ["idle", "working", "failed", "approval", "done", "input"],
      project: [
        { key: "app", inbox: ["idle", "approval", "done", "input"], settled: ["settled"] },
        { key: "docs", inbox: ["working", "failed"], settled: [] },
      ],
      machine: [
        {
          key: `sidebar-machine:${localEnvironmentId}`,
          inbox: ["idle", "working", "approval"],
          settled: [],
        },
        {
          key: `sidebar-machine:${remoteEnvironmentId}`,
          inbox: ["failed", "done", "input"],
          settled: ["settled"],
        },
      ],
      status: [
        { key: "sidebar-status:needs_you", inbox: ["approval", "input"], settled: [] },
        { key: "sidebar-status:failed", inbox: ["failed"], settled: [] },
        { key: "sidebar-status:working", inbox: ["working"], settled: [] },
        { key: "sidebar-status:completed", inbox: ["done"], settled: [] },
        { key: "sidebar-status:idle", inbox: ["idle"], settled: [] },
      ],
    },
    status: {
      none: ["approval", "input", "failed", "working", "done", "idle"],
      project: [
        { key: "app", inbox: ["approval", "input", "done", "idle"], settled: ["settled"] },
        { key: "docs", inbox: ["failed", "working"], settled: [] },
      ],
      machine: [
        {
          key: `sidebar-machine:${localEnvironmentId}`,
          inbox: ["approval", "working", "idle"],
          settled: [],
        },
        {
          key: `sidebar-machine:${remoteEnvironmentId}`,
          inbox: ["input", "failed", "done"],
          settled: ["settled"],
        },
      ],
      status: [
        { key: "sidebar-status:needs_you", inbox: ["approval", "input"], settled: [] },
        { key: "sidebar-status:failed", inbox: ["failed"], settled: [] },
        { key: "sidebar-status:working", inbox: ["working"], settled: [] },
        { key: "sidebar-status:completed", inbox: ["done"], settled: [] },
        { key: "sidebar-status:idle", inbox: ["idle"], settled: [] },
      ],
    },
  };

  it.each(SORTS.flatMap((sort) => GROUPINGS.map((grouping) => [sort, grouping] as const)))(
    "sort %s with grouping %s",
    (sort, grouping) => {
      expect(arrange(sort, grouping)).toEqual(expected[sort][grouping]);
    },
  );

  it("shows one machine folder when every thread runs on one machine", () => {
    const folders = groupSidebarThreads({
      grouping: "machine",
      projectGroups,
      machines,
      primaryEnvironmentId: localEnvironmentId,
      inbox: active.filter((entry) => entry.environmentId === localEnvironmentId),
      settled: [],
      statusGroupOf,
    });
    expect(folders.map((folder) => folder.header)).toEqual([
      { kind: "machine", environmentId: localEnvironmentId, label: "Workstation" },
    ]);
  });

  it("keeps threads from a machine that left the list visible", () => {
    const gone = EnvironmentId.make("environment-gone");
    const folders = groupSidebarThreads({
      grouping: "machine",
      projectGroups,
      machines,
      primaryEnvironmentId: localEnvironmentId,
      inbox: [thread("orphan", { environmentId: gone })],
      settled: [],
      statusGroupOf,
    });
    expect(folders.map((folder) => folder.header)).toEqual([
      { kind: "machine", environmentId: gone, label: "Unknown machine" },
    ]);
  });

  it("saves each folder's open state under its own key", () => {
    for (const grouping of ["machine", "status"] as const) {
      const folders = groupSidebarThreads({
        grouping,
        projectGroups,
        machines,
        primaryEnvironmentId: localEnvironmentId,
        inbox: active,
        settled,
        statusGroupOf,
      });
      expect(folders.map((folder) => folder.expansionKeys)).toEqual(
        folders.map((folder) => [folder.key]),
      );
    }
  });
});
