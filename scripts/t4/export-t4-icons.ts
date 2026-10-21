#!/usr/bin/env node

// Renders the fork's T4 icon over upstream's production Windows, web and Linux
// icons. Icon Composer only runs on macOS, so the sources are plain SVGs: the
// 16, 24 and 32 px drawings are fitted to the pixel grid, and every other size
// is rendered from icon.svg. macOS and iOS keep upstream's exports.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import { BRAND_ASSET_PATHS } from "../lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "../lib/icon-export.ts";

const SOURCE_DIRECTORY = "assets/prod/t4";
const SOURCE_SIZE = 128;
const PIXEL_FITTED_SIZES: ReadonlySet<number> = new Set([16, 24, 32]);

class T4IconRenderError extends Schema.TaggedError<T4IconRenderError>()("T4IconRenderError", {
  size: Schema.Number,
  cause: Schema.Defect(),
}) {}

const renderIcon = Effect.fn("t4Icons.renderIcon")(function* (
  repositoryRoot: string,
  size: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fitted = PIXEL_FITTED_SIZES.has(size);
  const source = yield* fs.readFile(
    path.join(repositoryRoot, SOURCE_DIRECTORY, fitted ? `icon-${size}.svg` : "icon.svg"),
  );
  // Rasterize the vector at the target size instead of scaling a bitmap down.
  const density = fitted ? 72 : (72 * size) / SOURCE_SIZE;
  return yield* Effect.tryPromise({
    try: () => sharp(source, { density }).png().toBuffer(),
    catch: (cause) => new T4IconRenderError({ size, cause }),
  });
});

const exportT4Icons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const ico = encodePngIco(
    yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
      renderIcon(repositoryRoot, size).pipe(Effect.map((contents) => ({ size, contents }))),
    ),
  );
  const outputs = [
    [BRAND_ASSET_PATHS.productionWindowsIconIco, ico],
    [BRAND_ASSET_PATHS.productionWebFaviconIco, ico],
    [BRAND_ASSET_PATHS.productionWebFavicon16Png, yield* renderIcon(repositoryRoot, 16)],
    [BRAND_ASSET_PATHS.productionWebFavicon32Png, yield* renderIcon(repositoryRoot, 32)],
    [BRAND_ASSET_PATHS.productionWebAppleTouchIconPng, yield* renderIcon(repositoryRoot, 180)],
    [BRAND_ASSET_PATHS.productionLinuxIconPng, yield* renderIcon(repositoryRoot, 1024)],
  ] as const;
  for (const [relativePath, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, relativePath), contents);
    yield* Console.log(`wrote ${relativePath}`);
  }
});

if (import.meta.main) {
  exportT4Icons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
