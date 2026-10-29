import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type ContextMenuItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  effects: [] as string[],
  completed: deferred<void>(),
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
      position: { x: number; y: number },
    ) => Promise<ThreadActionMenuId | null>
  >(),
}));

function recordEffect(action: string) {
  state.effects.push(action);
  state.completed.resolve();
}

vi.mock("../components/CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("../components/ThreadIconDialog", () => ({
  requestThreadIcon: async () => ({ kind: "emoji", emoji: "x" }),
}));
vi.mock("./useStartThreadTopic", () => ({
  useStartThreadTopic: () => async () => recordEffect("start-topic"),
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: async () => recordEffect("project-settings") }),
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAccountFailover: () => false,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readEnvironmentSupportsThreadIcons: () => true,
  readEnvironmentSupportsThreadTopics: () => true,
  readThreadShell: () => ({
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    title: "Thread",
    branch: "main",
    worktreePath: null,
    runtime: null,
    latestRun: null,
    source: {},
  }),
  readThreadShells: () => [],
  useDelegatedUnderParent: () => new Set(),
  useProjects: () => [{ id: "project", environmentId: "secondary" }],
}));
vi.mock("../components/Sidebar.viewOptions", () => ({ resolveSidebarStatusGroup: () => "idle" }));
// Its imports reach the composer, whose tooltips need a real React.
vi.mock("../components/Sidebar.logic", () => ({
  resolveSidebarThreadSection: () => "recent",
  resolveSidebarTopicOf: () => null,
  sidebarTopicLinks: () => new Map(),
}));
vi.mock("../components/Sidebar.background", () => ({
  sidebarBackgroundMenuItem: () => ({ placement: "front", available: true }),
  useSidebarBackground: () => ({
    choices: {},
    place: (_threads: unknown, placement: string) => recordEffect(placement),
  }),
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: "metadata" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    recordEffect("metadata");
    return AsyncResult.success(undefined);
  },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.show, close: () => {} },
    dialogs: {
      confirm: async () => {
        recordEffect("confirm");
        return false;
      },
    },
  }),
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project",
  derivePhysicalProjectKey: () => "project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../sidebarProjectGrouping", () => ({
  buildPhysicalToLogicalProjectKeyMap: () => new Map(),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadUnread: () => recordEffect("mark-unread"),
    }),
}));
vi.mock("../threadMemory", () => ({
  readEnvironmentSupportsFreshStart: () => false,
  readThreadMemoryPath: () => null,
  useFreshStartThread: () => () => {},
  useOpenLinkedThread: () => () => {},
  useOpenThreadMemory: () => () => {},
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: () => state.completed.resolve() },
}));
vi.mock("../components/Sidebar.snooze", () => ({
  resolveSnoozePresets: () => [
    { id: "hour", label: "In 1 hour", whenLabel: "3 PM", snoozedUntil: "2099-01-01T00:00:00Z" },
  ],
  snoozeWakeDescription: () => "later",
}));
vi.mock("./useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: () => recordEffect("copy") }),
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => recordEffect("draft"),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      confirmThreadDelete: true,
      confirmThreadArchive: true,
      timestampFormat: "12-hour",
    }),
}));
vi.mock("./useThreadActions", () => ({
  useDismissThreadAttention: () => () => recordEffect("dismiss-attention"),
  useSetThreadIcon: () => (_target: unknown, icon: unknown) =>
    recordEffect(icon === null ? "use-project-icon" : "change-icon"),
  useThreadActions: () =>
    Object.fromEntries(
      [
        "markThreadUnread",
        "settleThread",
        "unsettleThread",
        "snoozeThread",
        "unsnoozeThread",
        "pinThread",
        "confirmAndUnpinThread",
        "archiveThread",
        "deleteThread",
      ].map((action) => [
        action,
        async () => {
          recordEffect(action === "markThreadUnread" ? "mark-unread" : action);
          return AsyncResult.success(undefined);
        },
      ]),
    ),
}));

import { useThreadActionMenu } from "./useThreadActionMenu";

const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const position = { x: 10, y: 20 };
const createMenu = () =>
  useThreadActionMenu({
    threadRef: target,
    projectCwd: "/project",
    onStartRename: () => recordEffect("rename"),
    canShareWithGuest: false,
  });

beforeEach(() => {
  state.granted = new Set(["primary"]);
  state.effects = [];
  state.completed = deferred<void>();
  state.show.mockReset().mockResolvedValue(null);
});

describe("thread menu permissions", () => {
  it.each([
    "rename",
    "regenerate-title",
    "delete",
    "pin",
    "settle",
    "archive",
    "start-topic",
    "change-icon",
    "use-project-icon",
  ] as const)("%s rechecks after the native menu closes", async (action) => {
    state.granted.add("secondary");
    const choice = deferred<ThreadActionMenuId | null>();
    state.show.mockReturnValue(choice.promise);
    createMenu().openMenu(position);
    state.granted.delete("secondary");
    choice.resolve(action);
    await state.completed.promise;
    expect(state.effects).toEqual([]);
  });

  it.each(["start-topic", "change-icon", "use-project-icon"] as const)(
    "runs %s with permission",
    async (action) => {
      state.granted.add("secondary");
      state.show.mockResolvedValue(action);
      createMenu().openMenu(position);
      await state.completed.promise;
      expect(state.effects).toEqual([action]);
    },
  );

  it("keeps Bring to front available without task permission", async () => {
    state.show.mockResolvedValue("bring-to-front");
    createMenu().openMenu(position);
    await state.completed.promise;
    expect(state.effects).toEqual(["front"]);
  });
});
