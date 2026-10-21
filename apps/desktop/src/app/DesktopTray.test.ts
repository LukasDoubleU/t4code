import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopTray from "./DesktopTray.ts";

const fixture = Effect.gen(function* () {
  const opened = yield* Deferred.make<void>();
  const quit = yield* Deferred.make<void>();
  const openCount = yield* Ref.make(0);
  const callbacks = yield* Ref.make<Option.Option<ElectronTray.ElectronTrayOptions>>(Option.none());
  const layer = Layer.mergeAll(
    DesktopTray.layer,
    DesktopState.layer,
    Layer.succeed(DesktopAssets.DesktopAssets, {
      iconPaths: Effect.succeed({
        ico: Option.some("icon.ico"),
        png: Option.none(),
        icns: Option.none(),
      }),
      resolveResourcePath: () => Effect.succeedNone,
    }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform: "win32",
      displayName: "T4 Code",
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.succeed(ElectronTray.ElectronTray, {
      create: (options) => Ref.set(callbacks, Option.some(options)),
    }),
    Layer.succeed(ElectronApp.ElectronApp, {
      ...ElectronApp.make,
      quit: Deferred.succeed(quit, undefined).pipe(Effect.asVoid),
    }),
    Layer.succeed(DesktopWindow.DesktopWindow, {
      createMain: Effect.die("unexpected window creation"),
      ensureMain: Effect.die("unexpected window creation"),
      revealOrCreateMain: Effect.die("unexpected window creation"),
      activate: Ref.update(openCount, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(opened, undefined)),
        Effect.asVoid,
      ),
      createMainIfBackendReady: Effect.void,
      showConnectingSplash: Effect.void,
      handleBackendReady: () => Effect.void,
      handleBackendNotReady: Effect.void,
      flushMainWindowBounds: Effect.void,
      prepareCaptureReveal: Effect.void,
      dispatchMenuAction: () => Effect.void,
      dispatchSnapShotEvent: () => Effect.void,
      zoomMain: () => Effect.void,
      runMainContentsCommand: () => Effect.void,
      syncAppearance: Effect.void,
    }),
  );
  return { opened, quit, openCount, callbacks, layer };
});

describe("DesktopTray", () => {
  it.effect("clears availability when the tray scope closes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const tray = yield* DesktopTray.DesktopTray;
        yield* Effect.scoped(tray.configure);
        assert.isFalse(yield* tray.available);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("does not reopen a window during shutdown", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopTray.DesktopTray;
          const state = yield* DesktopState.DesktopState;
          yield* tray.configure;
          yield* Ref.set(state.quitting, true);
          Option.getOrThrow(yield* Ref.get(f.callbacks)).open();
          yield* Effect.yieldNow;
          assert.isFalse(yield* Deferred.isDone(f.opened));
        }),
      ).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("reopens from the tray and sends explicit Quit through app shutdown", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopTray.DesktopTray;
          yield* tray.configure;
          assert.isTrue(yield* tray.available);
          const callbacks = Option.getOrThrow(yield* Ref.get(f.callbacks));
          callbacks.open();
          callbacks.open();
          yield* Deferred.await(f.opened);
          assert.equal(yield* Ref.get(f.openCount), 1);
          callbacks.quit();
          yield* Deferred.await(f.quit);
        }),
      ).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("does not keep Windows alive when native tray creation fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopTray.DesktopTray;
          yield* tray.configure.pipe(
            Effect.provideService(ElectronTray.ElectronTray, {
              create: () =>
                Effect.fail(
                  new ElectronTray.ElectronTrayCreateError({ cause: new Error("no tray") }),
                ),
            }),
          );
          assert.isFalse(yield* tray.available);
        }),
      ).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("does not keep Windows alive when no icon is installed", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopTray.DesktopTray;
          yield* tray.configure.pipe(
            Effect.provideService(DesktopAssets.DesktopAssets, {
              iconPaths: Effect.succeed({
                ico: Option.none(),
                png: Option.none(),
                icns: Option.none(),
              }),
              resolveResourcePath: () => Effect.succeedNone,
            }),
          );
          assert.isFalse(yield* tray.available);
          assert.isTrue(Option.isNone(yield* Ref.get(f.callbacks)));
        }),
      ).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect.each(["darwin", "linux"] as const)("does not create a tray on %s", (platform) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopTray.DesktopTray;
          yield* tray.configure.pipe(
            Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
              platform,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
          );
          assert.isFalse(yield* tray.available);
          assert.isTrue(Option.isNone(yield* Ref.get(f.callbacks)));
        }),
      ).pipe(Effect.provide(f.layer));
    }),
  );
});
