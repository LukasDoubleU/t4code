import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import {
  isInSidebarBackground,
  isSidebarBackgroundThread,
  placeSidebarThreads,
  sidebarBackgroundMenuPlacement,
  type SidebarBackgroundChoices,
} from "./Sidebar.background";
import { resolveSidebarThreadSection } from "./Sidebar.logic";
import {
  groupSidebarThreads,
  resolveSidebarStatusGroup,
  sortSidebarActiveThreads,
  type SidebarGrouping,
  type SidebarThreadSort,
} from "./Sidebar.viewOptions";

const NOW = "2026-06-02T14:00:00.000Z";
const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");
const appProjectId = ProjectId.make("app");
const docsProjectId = ProjectId.make("docs");
const at = (time: string) => `2026-06-02T${time}:00.000Z`;

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
    updatedAt: at("07:00"),
    ...extra,
  };
}

// A thread whose latest run finished at 09:05.
const finished = {
  latestRun: {
    runId: RunId.make("run-1"),
    status: "completed",
    requestedAt: at("09:00"),
    startedAt: at("09:00"),
    completedAt: at("09:05"),
    assistantMessageId: null,
  },
  runtime: runtime("completed"),
} satisfies Partial<Thread>;

/**
 * An agent started the thread unless `createdBy` says otherwise. `promptedAt` is a message in
 * the user's role that the agent sent; `userWroteAt` is the user's own.
 */
function thread(
  id: string,
  input: {
    readonly createdBy?: Thread["source"]["createdBy"];
    readonly promptedAt?: string;
    readonly userWroteAt?: string;
  } & Partial<Thread> = {},
): Thread {
  const { createdBy = "agent", promptedAt, userWroteAt, ...overrides } = input;
  const base = makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: localEnvironmentId,
    projectId: appProjectId,
    latestUserMessageAt: userWroteAt ?? promptedAt ?? null,
    latestUserAuthoredMessageAt: userWroteAt ?? null,
    ...overrides,
  });
  return { ...base, source: { ...base.source, createdBy } };
}

/** The thread as a server that does not tell the user's messages from an agent's sends it. */
function fromOlderServer(entry: Thread) {
  const { latestUserAuthoredMessageAt: _unknown, ...rest } = entry;
  return rest;
}

const statusGroupOf = (entry: Thread) =>
  resolveSidebarStatusGroup(entry, { now: NOW, localLastVisitedAt: undefined });
const inBackground = (entry: Thread, choices: SidebarBackgroundChoices | null = {}) =>
  isInSidebarBackground(entry, choices, statusGroupOf);

describe("isSidebarBackgroundThread", () => {
  it("holds a thread an agent started until the user writes in it", () => {
    expect(isSidebarBackgroundThread(thread("launched"), undefined)).toBe(true);
    // The agent's own prompt arrives in the user's role but is not the user's.
    expect(
      isSidebarBackgroundThread(thread("prompted", { promptedAt: at("09:00") }), undefined),
    ).toBe(true);
    expect(
      isSidebarBackgroundThread(
        thread("answered", { promptedAt: at("09:00"), userWroteAt: at("10:00") }),
        undefined,
      ),
    ).toBe(false);
    expect(isSidebarBackgroundThread(thread("mine", { createdBy: "user" }), undefined)).toBe(false);
    expect(isSidebarBackgroundThread(thread("imported", { createdBy: "system" }), undefined)).toBe(
      false,
    );
  });

  it("counts any message in the user's role from servers that do not tell them apart", () => {
    expect(isSidebarBackgroundThread(fromOlderServer(thread("launched")), undefined)).toBe(true);
    expect(
      isSidebarBackgroundThread(
        fromOlderServer(thread("prompted", { promptedAt: at("09:00") })),
        undefined,
      ),
    ).toBe(false);
  });

  it("keeps a thread moved there by hand until the user writes again", () => {
    const mine = thread("mine", { createdBy: "user", userWroteAt: at("09:00") });
    const moved = { placement: "background", userMessageAt: at("09:00") } as const;
    expect(isSidebarBackgroundThread(mine, moved)).toBe(true);
    expect(
      isSidebarBackgroundThread({ ...mine, latestUserAuthoredMessageAt: at("11:00") }, moved),
    ).toBe(false);
  });

  it("keeps a thread brought to front out for good", () => {
    expect(isSidebarBackgroundThread(thread("launched"), { placement: "front" })).toBe(false);
  });
});

describe("isInSidebarBackground", () => {
  it("lists nothing while the section is off", () => {
    expect(inBackground(thread("launched"), null)).toBe(false);
  });

  it("lets a thread into the main list while it needs the user", () => {
    const woke = {
      snoozedAt: at("04:00"),
      snoozedUntil: at("05:00"),
      lastVisitedAt: at("04:00"),
    };
    const forward = [
      thread("approval", { hasPendingApprovals: true }),
      thread("input", { hasPendingUserInput: true }),
      thread("subagent-asks", { pendingSubagentRequest: "approval" }),
      thread("woke", woke),
      thread("failed", { runtime: runtime("failed") }),
      thread("limited", { runtime: runtime("failed", { lastErrorClass: "usage_limit" }) }),
    ];
    expect(forward.filter((entry) => inBackground(entry)).map((entry) => entry.id)).toEqual([]);
    const quiet = [
      thread("running", { runtime: runtime("running") }),
      thread("waiting", { runtime: runtime("idle") }),
      thread("done", { ...finished, lastVisitedAt: at("09:01") }),
      thread("seen", { ...finished, lastVisitedAt: NOW }),
    ];
    expect(quiet.every((entry) => inBackground(entry))).toBe(true);
  });

  it("returns a thread to Background once the user handled what it asked", () => {
    const asking = thread("asking", { hasPendingApprovals: true, runtime: runtime("running") });
    expect(inBackground(asking)).toBe(false);
    expect(inBackground({ ...asking, hasPendingApprovals: false })).toBe(true);
  });

  it("lets a settled thread settle, like snoozed and pinned ones keep their sections", () => {
    const settled = thread("settled", { ...finished, settledOverride: "settled" });
    expect(inBackground(settled)).toBe(false);
    const sectionOf = (flags: { snoozed?: boolean; settled?: boolean; pinned?: boolean }) =>
      resolveSidebarThreadSection({
        snoozed: false,
        settled: false,
        pinned: false,
        ...flags,
        background: true,
      });
    expect(sectionOf({})).toBe("background");
    expect(sectionOf({ pinned: true })).toBe("pinned");
    expect(sectionOf({ snoozed: true })).toBe("snoozed");
    expect(sectionOf({ settled: true })).toBe("settled");
  });
});

describe("placeSidebarThreads", () => {
  it("moves the user's own thread to Background until they write in it again", () => {
    const mine = thread("mine", { createdBy: "user", userWroteAt: at("09:00") });
    const choices = placeSidebarThreads({}, [mine], "background");
    expect(inBackground(mine, choices)).toBe(true);
    expect(inBackground({ ...mine, latestUserAuthoredMessageAt: at("12:00") }, choices)).toBe(
      false,
    );
  });

  it("brings an agent's thread to front and back without leaving a choice behind", () => {
    const launched = thread("launched");
    const front = placeSidebarThreads({}, [launched], "front");
    expect(inBackground(launched, front)).toBe(false);
    const back = placeSidebarThreads(front, [launched], "background");
    expect(back).toEqual({});
    expect(inBackground(launched, back)).toBe(true);
    expect(placeSidebarThreads({}, [thread("mine", { createdBy: "user" })], "front")).toEqual({});
  });

  it("keeps each machine's thread apart and leaves other choices alone", () => {
    const here = thread("launched");
    const there = thread("launched", { environmentId: remoteEnvironmentId });
    const choices = placeSidebarThreads({}, [there], "front");
    expect(inBackground(here, choices)).toBe(true);
    expect(inBackground(there, choices)).toBe(false);
    const both = placeSidebarThreads(choices, [here], "front");
    expect([here, there].map((entry) => inBackground(entry, both))).toEqual([false, false]);
  });
});

describe("sidebarBackgroundMenuPlacement", () => {
  const menu = (entry: Thread, choices: SidebarBackgroundChoices | null = {}, parked = false) =>
    sidebarBackgroundMenuPlacement({ thread: entry, choices, parked });

  it("offers the side the section does not put the thread on", () => {
    expect(menu(thread("launched"))).toBe("front");
    // Still Background's while it waits for the user in the main list.
    expect(menu(thread("asking", { hasPendingApprovals: true }))).toBe("front");
    expect(menu(thread("mine", { createdBy: "user" }))).toBe("background");
  });

  it("offers neither while the section is off or the thread is pinned, snoozed or settled", () => {
    expect(menu(thread("launched"), null)).toBeNull();
    expect(menu(thread("launched"), {}, true)).toBeNull();
  });
});

describe("Background with every sort and grouping", () => {
  const SORTS: readonly SidebarThreadSort[] = ["manual", "last_message", "status"];
  const GROUPINGS: readonly SidebarGrouping[] = ["none", "project", "machine", "status"];
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
  // Background spans projects and machines; the docs project has no other thread.
  const threads = [
    thread("bg-running", {
      projectId: docsProjectId,
      runtime: runtime("running"),
      promptedAt: at("12:00"),
      activeOrderKey: "a",
    }),
    thread("bg-done", {
      environmentId: remoteEnvironmentId,
      ...finished,
      lastVisitedAt: at("09:01"),
      promptedAt: at("09:00"),
      activeOrderKey: "c",
    }),
    thread("bg-seen", {
      ...finished,
      lastVisitedAt: NOW,
      promptedAt: at("13:00"),
      activeOrderKey: "b",
    }),
    thread("bg-asks", { hasPendingApprovals: true, promptedAt: at("10:00"), activeOrderKey: "d" }),
    thread("mine-running", {
      createdBy: "user",
      runtime: runtime("running"),
      userWroteAt: at("11:00"),
      activeOrderKey: "e",
    }),
    thread("mine-seen", {
      createdBy: "user",
      environmentId: remoteEnvironmentId,
      ...finished,
      lastVisitedAt: NOW,
      userWroteAt: at("08:00"),
      activeOrderKey: "f",
    }),
  ];
  const background = threads.filter((entry) => inBackground(entry));
  const main = threads.filter((entry) => !inBackground(entry));

  const backgroundOrder: Record<SidebarThreadSort, readonly string[]> = {
    manual: ["bg-running", "bg-seen", "bg-done"],
    last_message: ["bg-seen", "bg-running", "bg-done"],
    status: ["bg-done", "bg-running", "bg-seen"],
  };
  // Folders hold the main list only; the docs folder stays though its thread waits in Background.
  const folders: Record<Exclude<SidebarGrouping, "none">, Record<string, readonly string[]>> = {
    project: { app: ["bg-asks", "mine-running", "mine-seen"], docs: [] },
    machine: {
      [`sidebar-machine:${localEnvironmentId}`]: ["bg-asks", "mine-running"],
      [`sidebar-machine:${remoteEnvironmentId}`]: ["mine-seen"],
    },
    status: {
      "sidebar-status:needs_you": ["bg-asks"],
      "sidebar-status:working": ["mine-running"],
      "sidebar-status:idle": ["mine-seen"],
    },
  };

  it.each(SORTS.flatMap((sort) => GROUPINGS.map((grouping) => [sort, grouping] as const)))(
    "sort %s with grouping %s",
    (sort, grouping) => {
      expect(sortSidebarActiveThreads(background, sort, statusGroupOf).map((e) => e.id)).toEqual(
        backgroundOrder[sort],
      );
      const inbox = sortSidebarActiveThreads(main, sort, statusGroupOf);
      if (grouping === "none") {
        expect(inbox.map((entry) => entry.id).toSorted()).toEqual([
          "bg-asks",
          "mine-running",
          "mine-seen",
        ]);
        return;
      }
      const grouped = groupSidebarThreads({
        grouping,
        projectGroups,
        machines,
        primaryEnvironmentId: localEnvironmentId,
        inbox,
        settled: [],
        statusGroupOf,
      });
      expect(
        Object.fromEntries(
          grouped.map((folder) => [folder.key, folder.inbox.map((e) => e.id).toSorted()]),
        ),
      ).toEqual(folders[grouping]);
    },
  );
});
