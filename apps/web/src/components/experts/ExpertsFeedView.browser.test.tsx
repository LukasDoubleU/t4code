import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadTailMessage,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { makeThreadFixture } from "../../test-fixtures";
import type { ExpertTail } from "../../state/expertsFeed";

const mocks = vi.hoisted(() => ({
  threads: [] as EnvironmentThreadShell[],
  tails: new Map<string, ExpertTail>(),
  startTurn: vi.fn(),
}));

vi.mock(import("@effect/atom-react"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomValue: ((atom: Parameters<typeof actual.useAtomValue>[0]) =>
      atom === primaryServerKeybindingsAtom
        ? DEFAULT_RESOLVED_KEYBINDINGS
        : actual.useAtomValue(atom)) as typeof actual.useAtomValue,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: () => mocks.threads,
  useDelegatedUnderParent: () => new Set<string>(),
  useServerConfigs: () => new Map(),
  useProject: () => null,
  useQuietThreadShell: (ref) =>
    mocks.threads.find(
      (thread) => thread.environmentId === ref?.environmentId && thread.id === ref.threadId,
    ) ?? null,
}));
vi.mock(import("../../state/expertsFeed"), () => ({
  useExpertTails: (keys) => keys.map((key) => mocks.tails.get(key) ?? { status: "loading" }),
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (environmentId) =>
    environmentId === there ? ({ label: "Build box" } as ReturnType<typeof useEnvironment>) : null,
  usePrimaryEnvironmentId: () => here,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: () => mocks.startTurn,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (_environmentId, select) =>
    select!({ followUpBehavior: "queue" } as Parameters<NonNullable<typeof select>>[0]),
}));

import { useEnvironment } from "../../state/environments";
import { ExpertsFeedView } from "./ExpertsFeedView";

const here = EnvironmentId.make("environment-here");
const there = EnvironmentId.make("environment-there");

function expert(environmentId: EnvironmentId, id: string, title: string, running = false) {
  return presentThreadShell(environmentId, {
    ...makeThreadFixture({ environmentId, id: ThreadId.make(id), title }).source,
    pinnedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
    ...(running
      ? { latestRunId: RunId.make("run-9"), status: "running", activeRunId: RunId.make("run-9") }
      : {}),
  });
}

function message(
  id: string,
  createdAt: string,
  fields: Partial<OrchestrationV2ThreadTailMessage> = {},
): OrchestrationV2ThreadTailMessage {
  return {
    itemId: TurnItemId.make(id),
    messageId: MessageId.make(id),
    runId: null,
    role: "assistant",
    text: id,
    textTruncated: false,
    streaming: false,
    createdAt,
    ...fields,
  };
}

function setup() {
  const local = expert(here, "local-expert", "Docs expert");
  const remote = expert(there, "remote-expert", "Build expert", true);
  const sender = presentThreadShell(here, {
    ...makeThreadFixture({ environmentId: here, id: ThreadId.make("planner"), title: "Planner" })
      .source,
  });
  mocks.threads = [local, remote, sender];
  mocks.tails = new Map<string, ExpertTail>([
    [
      `${here}:local-expert`,
      {
        status: "ready",
        messages: [
          message("Docs reply", "2026-10-23T09:00:00.000Z"),
          message("ask", "2026-10-23T11:00:00.000Z", {
            role: "user",
            text: "Are the docs current?",
            createdBy: "agent",
            creationSource: "mcp",
            senderThreadId: ThreadId.make("planner"),
          }),
        ],
      },
    ],
    [
      `${there}:remote-expert`,
      { status: "ready", messages: [message("Build reply", "2026-10-23T10:00:00.000Z")] },
    ],
  ]);
  mocks.startTurn.mockReset();
  mocks.startTurn.mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
  return { remote };
}

it("lists every expert's messages in time order, named with expert and machine", async () => {
  setup();
  await using screen = await render(<ExpertsFeedView />, { router: "/experts" });
  const entries = screen.container.querySelectorAll('[data-testid="experts-feed-entry"]');
  expect([...entries].map((entry) => entry.querySelector("a")?.textContent)).toEqual([
    "Docs expert",
    "Build expert",
    "Docs expert",
  ]);
  expect(entries[1]?.textContent).toContain("Build box");
  expect(entries[0]?.textContent).not.toContain("Build box");
  // Another agent's message folds into one line naming the sender.
  await expect
    .element(screen.getByRole("button", { name: /Planner.*Are the docs current\?/ }))
    .toBeVisible();
});

it("replies into the expert's own thread, queued behind its running turn", async () => {
  const { remote } = setup();
  await using screen = await render(<ExpertsFeedView />, { router: "/experts" });
  const buildEntry = screen.container.querySelectorAll('[data-testid="experts-feed-entry"]')[1]!;
  await userEvent.click(
    [...buildEntry.querySelectorAll("button")].find((button) => button.textContent === "Reply")!,
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Reply to Build expert" }), "Ship it");
  await userEvent.keyboard("{Enter}");

  expect(mocks.startTurn).toHaveBeenCalledOnce();
  expect(mocks.startTurn.mock.calls[0]![0]).toMatchObject({
    environmentId: there,
    input: {
      threadId: "remote-expert",
      message: { role: "user", text: "Ship it", attachments: [] },
      runtimeMode: remote.runtimeMode,
      interactionMode: remote.interactionMode,
      dispatchMode: "queue",
    },
  });
  await expect
    .element(screen.getByRole("textbox", { name: "Reply to Build expert" }))
    .not.toBeInTheDocument();
});
