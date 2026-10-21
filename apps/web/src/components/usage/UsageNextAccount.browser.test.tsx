import { act, render } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// Select popups need the app's stacking styles to take real pointer clicks.
import "~/index.css";

vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../settings/RedactedSensitiveText", () => ({ RedactedSensitiveText: () => null }));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const now = Date.parse("2026-10-21T12:00:00.000Z");
const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

const session = (usedPercent: number, resetsInHours?: number): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  windowDurationMins: 300,
  ...(resetsInHours === undefined ? {} : { resetsAt: inHours(resetsInHours) }),
});
const weekly = (
  usedPercent: number,
  resetsInHours?: number,
  id = "seven_day",
  label = "Weekly",
): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label,
  usedPercent,
  windowDurationMins: 7 * 24 * 60,
  ...(resetsInHours === undefined ? {} : { resetsAt: inHours(resetsInHours) }),
});

const claude = (
  accounts: Record<string, readonly ServerProviderUsageWindow[]>,
): LimitPresentations =>
  new Map([
    [
      EnvironmentId.make("env-a"),
      {
        entry: { target: { label: "Test" } },
        serverConfig: {
          usageLimitSources: [],
          providers: Object.entries(accounts).map(
            ([name, windows]) =>
              ({
                instanceId: ProviderInstanceId.make(`claude_${name}`),
                driver: ProviderDriverKind.make("claudeAgent"),
                displayName: name,
                enabled: true,
                installed: true,
                version: null,
                status: "ready",
                auth: { status: "authenticated", email: `${name}@example.com` },
                checkedAt: "2026-10-21T11:55:00Z",
                models: [],
                slashCommands: [],
                skills: [],
                usageLimits: { checkedAt: "2026-10-21T11:55:00Z", windows },
              }) satisfies ServerProvider,
          ),
        },
      },
    ],
  ]);

const accounts = {
  c1: [session(10, 2), weekly(70, 24)],
  c2: [session(90, 2), weekly(50, 48)],
  c3: [session(20, 3), weekly(40, 96)],
  main: [session(0), weekly(0)],
};

function setup() {
  localStorage.removeItem("t3code:usage-next-account:v1");
}

const pick = () => page.getByRole("group", { name: "Use next for Claude" });
const pickText = () => pick().element().textContent;
const rows = () =>
  Array.from(
    document.querySelectorAll('[aria-label="More Claude accounts"] > li'),
    (row) => row.textContent,
  );

async function choose(select: string, option: string) {
  await userEvent.click(page.getByRole("combobox", { name: select }));
  await userEvent.click(page.getByRole("option", { name: option }));
}

it("names the account to use next, ranks the rest with reasons, and follows a refresh", async () => {
  setup();
  await using screen = await render(
    <UsageLimitsPooled presentations={claude(accounts)} now={now} />,
  );
  await expect.poll(pickText).toMatch(/^c1Weekly: 30% left, resets in 1d 0h · 30%\/day at risk/);
  expect(rows()).toEqual([
    expect.stringMatching(/^2c3Weekly: 60% left, resets in 4d 0h · 15%\/day at risk/),
    expect.stringMatching(/^3mainWeekly: not started, nothing at risk yet/),
    expect.stringMatching(/^c2Session: 10% left, below 25% until /),
  ]);

  await act(() =>
    screen.rerender(
      <UsageLimitsPooled
        presentations={claude({ ...accounts, c1: [session(10, 2), weekly(100, 24)] })}
        now={now}
      />,
    ),
  );
  await expect.poll(pickText).toMatch(/^c3Weekly: 60% left/);
  expect(rows().at(-1)).toMatch(/^c1Weekly: used up until /);
});

it("ranks with the session room the user asks for and keeps that choice", async () => {
  setup();
  {
    await using _screen = await render(
      <UsageLimitsPooled presentations={claude(accounts)} now={now} />,
    );
    await choose("Session room needed", "Needs 10% session");
    await expect
      .poll(rows)
      .toEqual([
        expect.stringMatching(/^2c2Weekly: 50% left, resets in 2d 0h · 25%\/day at risk/),
        expect.stringMatching(/^3c3/),
        expect.stringMatching(/^4main/),
      ]);
  }
  await using _screen = await render(
    <UsageLimitsPooled presentations={claude(accounts)} now={now} />,
  );
  await expect
    .element(page.getByRole("combobox", { name: "Session room needed" }))
    .toHaveTextContent("Needs 10% session");
  expect(rows()[0]).toMatch(/^2c2/);
});

it("counts a model's own weekly allowance until the user ranks for another model", async () => {
  setup();
  await using _screen = await render(
    <UsageLimitsPooled
      presentations={claude({
        c1: [session(10, 2), weekly(40, 48), weekly(100, 24, "seven_day_opus", "Weekly · Opus")],
        c3: accounts.c3,
      })}
      now={now}
    />,
  );
  const model = page.getByRole("combobox", { name: "Model to rank for" });
  await expect.element(model).toHaveTextContent("For any model");
  await expect.poll(pickText).toMatch(/^c3/);
  expect(rows()).toEqual([expect.stringMatching(/^c1Weekly · Opus: used up until /)]);

  await choose("Model to rank for", "For other models");
  await expect.poll(pickText).toMatch(/^c1Weekly: 60% left, resets in 2d 0h/);

  await choose("Model to rank for", "For Opus");
  await expect.poll(pickText).toMatch(/^c3/);
});

it("starts new threads on the recommended account until the user turns that off", async () => {
  setup();
  const startNewThreads = () =>
    page.getByRole("switch", { name: "Start new threads on the recommended account" });
  {
    await using _screen = await render(
      <UsageLimitsPooled presentations={claude(accounts)} now={now} />,
    );
    await expect.element(startNewThreads()).toBeChecked();
    await userEvent.click(startNewThreads());
    await expect.element(startNewThreads()).not.toBeChecked();
  }
  await using _screen = await render(
    <UsageLimitsPooled presentations={claude(accounts)} now={now} />,
  );
  await expect.element(startNewThreads()).not.toBeChecked();
});
