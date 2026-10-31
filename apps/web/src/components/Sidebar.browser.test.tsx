import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  emitThreadShell,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("folds quiet experts into one row that opens in place, and lets one out on a message", async () => {
  // The fixtures' messages and runs are months old, so every expert starts quiet.
  const experts = ["docs", "release", "triage"].map((name) => ({
    ...threadWithHistory(`expert-${name}`, 1),
    title: `Expert ${name}`,
    pinnedAt: DateTime.makeUnsafe("2026-03-17T19:12:28.000Z"),
  }));
  using _environment = installFakeEnvironment([...experts, threadWithHistory("inbox", 1)]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });

  const fold = page.getByTestId("sidebar-quiet-experts").getByRole("treeitem");
  const expertRow = (title: string) =>
    page.getByTestId("sidebar-row-expert").filter({ hasText: title });
  const docs = expertRow("Expert docs");
  await expect.element(fold).toHaveTextContent("3 quiet");
  await expect.element(docs).not.toBeInTheDocument();

  await userEvent.click(fold);
  await expect.element(docs).toBeVisible();
  await expect.element(expertRow("Expert triage")).toBeVisible();
  await userEvent.click(fold);
  await expect.element(docs).not.toBeInTheDocument();

  // Later than any clock this runs on, so the message is always within the quiet window.
  await emitThreadShell({
    ...experts[0]!,
    latestUserMessageAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
  });
  await expect.element(docs).toBeVisible();
  await expect.element(fold).toHaveTextContent("2 quiet");
});
