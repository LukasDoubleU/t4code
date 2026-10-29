import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopState from "./DesktopState.ts";

type DesktopTrayServices =
  | DesktopAssets.DesktopAssets
  | DesktopEnvironment.DesktopEnvironment
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTray.ElectronTray;

/** @effect-expect-leaking DesktopAssets | DesktopEnvironment | DesktopState | DesktopWindow | ElectronApp | ElectronTray */
export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly available: Effect.Effect<boolean>;
    readonly configure: Effect.Effect<void, never, Scope.Scope | DesktopTrayServices>;
  }
>()("@t3tools/desktop/app/DesktopTray") {}

const { logError } = makeComponentLogger("desktop-tray");

/** @public */
export const make = Effect.gen(function* () {
  const available = yield* Ref.make(false);
  return DesktopTray.of({
    available: Ref.get(available),
    configure: Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      if (environment.platform !== "win32" || (yield* Ref.get(available))) return;
      const assets = yield* DesktopAssets.DesktopAssets;
      const paths = yield* assets.iconPaths;
      const iconPath = Option.orElse(paths.ico, () => paths.png);
      if (Option.isNone(iconPath)) {
        yield* logError("no tray icon available; closing the last window will quit");
        return;
      }
      const app = yield* ElectronApp.ElectronApp;
      const window = yield* DesktopWindow.DesktopWindow;
      const state = yield* DesktopState.DesktopState;
      const tray = yield* ElectronTray.ElectronTray;
      const runEffect = Effect.runPromiseWith(yield* Effect.context<DesktopTrayServices>());
      let opening = false;
      const open = () => {
        if (opening) return;
        opening = true;
        void runEffect(
          Effect.gen(function* () {
            if (!(yield* Ref.get(state.quitting))) yield* window.activate;
          }).pipe(Effect.catchCause((cause) => logError("failed to open from tray", { cause }))),
        ).finally(() => {
          opening = false;
        });
      };
      const quit = () => {
        void runEffect(app.quit);
      };
      yield* tray.create({
        iconPath: iconPath.value,
        appName: environment.displayName,
        open,
        quit,
      });
      yield* Ref.set(available, true);
      yield* Effect.addFinalizer(() => Ref.set(available, false));
    }).pipe(
      Effect.catchCause((cause) =>
        logError("tray unavailable; closing the last window will quit", { cause }),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopTray, make);
