import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  destroy: vi.fn(),
  setToolTip: vi.fn(),
  setContextMenu: vi.fn(),
  on: vi.fn(),
  buildFromTemplate: vi.fn(),
  isEmpty: vi.fn(() => false),
}));
vi.mock("electron", () => ({
  Tray: class {
    destroy = native.destroy;
    setToolTip = native.setToolTip;
    setContextMenu = native.setContextMenu;
    on = native.on;
  },
  Menu: { buildFromTemplate: native.buildFromTemplate },
  nativeImage: { createFromPath: () => ({ isEmpty: native.isEmpty }) },
}));

import * as ElectronTray from "./ElectronTray.ts";

describe("ElectronTray", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    native.isEmpty.mockReturnValue(false);
  });
  const options = { iconPath: "icon.ico", tooltip: "T3 Code", open: () => {}, quit: () => {} };

  it.effect("keeps the native tray until its scope closes", () =>
    Effect.gen(function* () {
      const tray = yield* ElectronTray.ElectronTray;
      yield* Effect.scoped(
        tray.create(options).pipe(
          Effect.andThen(
            Effect.sync(() => {
              assert.equal(native.destroy.mock.calls.length, 0);
            }),
          ),
        ),
      );
      assert.equal(native.destroy.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronTray.layer)),
  );

  it.effect("destroys a partially configured tray when menu creation fails", () =>
    Effect.gen(function* () {
      const cause = new Error("menu unavailable");
      native.buildFromTemplate.mockImplementation(() => {
        throw cause;
      });
      const tray = yield* ElectronTray.ElectronTray;
      const error = yield* Effect.scoped(tray.create(options).pipe(Effect.flip));
      assert.instanceOf(error, ElectronTray.ElectronTrayCreateError);
      assert.strictEqual(error.cause, cause);
      assert.equal(native.destroy.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronTray.layer)),
  );

  it.effect("rejects an empty icon rather than leaving an invisible background app", () =>
    Effect.gen(function* () {
      native.isEmpty.mockReturnValue(true);
      const tray = yield* ElectronTray.ElectronTray;
      yield* Effect.scoped(tray.create(options).pipe(Effect.flip));
      assert.equal(native.destroy.mock.calls.length, 0);
      assert.equal(native.on.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronTray.layer)),
  );
});
