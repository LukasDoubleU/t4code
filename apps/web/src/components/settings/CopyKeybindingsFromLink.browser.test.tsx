import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { CopyKeybindingsFromLink } from "./CopyKeybindingsFromLink";

const hostId = EnvironmentId.make("laptop");
const boxId = EnvironmentId.make("box");

// What the host answers: the machines it links to, and the copy's preview and outcome.
const server = vi.hoisted(() => ({
  linked: new Map<string, string>(),
  previews: [] as Array<unknown>,
  copies: [] as Array<unknown>,
}));

vi.mock(import("~/state/peerLinks"), async (original) => {
  const actual = await original();
  const EffectModule = await import("effect/Effect");
  return {
    ...actual,
    useLinkedEnvironments: (() => server.linked) as never,
    peerLinkEnvironment: {
      ...actual.peerLinkEnvironment,
      previewKeybindings: {
        label: "preview",
        run: (_registry: unknown, request: unknown) =>
          EffectModule.sync(() => {
            server.previews.push(request);
            return {
              environmentId: boxId,
              label: "Box",
              differing: 3,
              copyable: 2,
              skipped: 1,
            };
          }),
      } as never,
      copyKeybindings: {
        label: "copy",
        run: (_registry: unknown, request: unknown) =>
          EffectModule.sync(() => {
            server.copies.push(request);
            return {
              environmentId: boxId,
              label: "Box",
              copied: 2,
              skipped: 1,
              backupPath: "/data/keybindings.json.bak",
            };
          }),
      } as never,
    },
  };
});

describe("CopyKeybindingsFromLink", () => {
  it("shows nothing on a machine without links", async () => {
    server.linked = new Map();
    await using screen = await render(
      <CopyKeybindingsFromLink environmentId={hostId} disabled={false} />,
    );
    expect(screen.container.textContent).toBe("");
  });

  it("tells what differs and what is replaced before copying", async () => {
    server.linked = new Map([[boxId, "Box"]]);
    server.previews = [];
    server.copies = [];
    await using screen = await render(
      <CopyKeybindingsFromLink environmentId={hostId} disabled={false} />,
    );
    await screen.getByRole("button", { name: "Copy from a linked machine" }).click();

    // The only linked machine is compared at once.
    await expect.element(screen.getByText("3 keybindings differ from Box.")).toBeVisible();
    await expect
      .element(screen.getByText(/custom keybindings are replaced by the other machine/))
      .toBeVisible();
    await expect.element(screen.getByText(/1 keybinding there is for a command/)).toBeVisible();
    expect(server.copies).toEqual([]);

    await screen.getByRole("button", { name: "Replace with Box's" }).click();
    await expect
      .element(screen.getByText("3 keybindings differ from Box."))
      .not.toBeInTheDocument();
    expect(server.previews).toEqual([{ environmentId: hostId, input: { environmentId: boxId } }]);
    expect(server.copies).toEqual([{ environmentId: hostId, input: { environmentId: boxId } }]);
  });
});
