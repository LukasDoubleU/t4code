import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export interface ElectronTrayOptions {
  readonly iconPath: string;
  readonly tooltip: string;
  readonly open: () => void;
  readonly quit: () => void;
}

export class ElectronTrayCreateError extends Schema.TaggedError<ElectronTrayCreateError>()(
  "ElectronTrayCreateError",
  { cause: Schema.Defect() },
) {}

export class ElectronTray extends Context.Service<
  ElectronTray,
  {
    readonly create: (
      options: ElectronTrayOptions,
    ) => Effect.Effect<void, ElectronTrayCreateError, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronTray") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronTray.of({
  create: (options) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (Electron.nativeImage.createFromPath(options.iconPath).isEmpty()) {
            throw new Error("The tray icon could not be loaded.");
          }
          const tray = new Electron.Tray(options.iconPath);
          try {
            tray.setToolTip(options.tooltip);
            tray.setContextMenu(
              Electron.Menu.buildFromTemplate([
                { label: "Open T3 Code", click: options.open },
                { type: "separator" },
                { label: "Quit T3 Code", click: options.quit },
              ]),
            );
            tray.on("click", options.open);
            tray.on("double-click", options.open);
            return tray;
          } catch (cause) {
            tray.destroy();
            throw cause;
          }
        },
        catch: (cause) => new ElectronTrayCreateError({ cause }),
      }),
      (tray) => Effect.sync(() => tray.destroy()),
    ).pipe(Effect.asVoid),
});

export const layer = Layer.succeed(ElectronTray, make);
