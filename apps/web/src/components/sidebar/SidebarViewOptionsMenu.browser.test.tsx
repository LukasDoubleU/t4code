import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: persistence as never }),
  };
});

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { SidebarViewOptionsMenu } from "./SidebarViewOptionsMenu";

async function seedClientSettings(stored: Partial<ClientSettings>): Promise<Disposable> {
  __resetClientSettingsPersistenceForTests();
  persistence.getClientSettings
    .mockReset()
    .mockResolvedValue({ ...DEFAULT_CLIENT_SETTINGS, ...stored });
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  await ensureClientSettingsHydrated();
  return { [Symbol.dispose]: __resetClientSettingsPersistenceForTests };
}

const option = (group: RegExp, name: string) =>
  page.getByRole("group", { name: group }).getByRole("menuitemradio", { name });

it("leaves the order to the Working section until threads are grouped, and saves each choice", async () => {
  using _settings = await seedClientSettings({ sidebarWorkingShelfEnabled: true });
  await using screen = await render(
    <SidebarViewOptionsMenu trigger={<button type="button">View options</button>} />,
  );
  const openMenu = () => userEvent.click(screen.getByRole("button", { name: "View options" }));

  await openMenu();
  await expect.element(option(/^Sort/, "Manual")).toHaveAttribute("aria-checked", "true");
  await expect.element(option(/^Sort/, "Status")).toHaveAttribute("aria-disabled", "true");
  await expect.element(option(/^Group/, "None")).toHaveAttribute("aria-checked", "true");
  await userEvent.click(option(/^Group/, "Machine"));

  await openMenu();
  await expect.element(option(/^Group/, "Machine")).toHaveAttribute("aria-checked", "true");
  await expect.element(option(/^Sort/, "Status")).not.toHaveAttribute("aria-disabled", "true");
  await userEvent.click(option(/^Sort/, "Status"));

  await openMenu();
  await expect.element(option(/^Sort/, "Status")).toHaveAttribute("aria-checked", "true");
  await userEvent.click(option(/^Group/, "Project"));

  await openMenu();
  await expect.element(option(/^Group/, "Project")).toHaveAttribute("aria-checked", "true");
  // Project folders and the status sort land in the settings each device saves.
  expect(persistence.setClientSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      boringSidebarEnabled: true,
      legacySidebarEnabled: false,
      sidebarThreadGrouping: "none",
      sidebarSortByStatus: true,
      sidebarSortByLastMessage: false,
    }),
  );
});
