import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Toolkit } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as Keybindings from "../keybindings.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as PeerKeybindings from "./PeerKeybindings.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box", { linkKeybindings: true });
const NoTools = Toolkit.make();

const serveBox = (descriptor: ExecutionEnvironmentDescriptor = box) =>
  servePeer(
    descriptor,
    McpHttpServer.toolkitRegistration(NoTools, McpToolAccess.toLayer(NoTools, {})),
  );

const writeJson = (filePath: string, value: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, `${JSON.stringify(value, null, 2)}\n`);
  });

const readJson = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return JSON.parse(yield* fs.readFileString(filePath)) as unknown;
  });

/** The laptop: its links, its own keybindings, and the copy between them. */
const makeLaptop = Effect.gen(function* () {
  const linking = yield* Layer.build(layerLinkingEnvironment(laptop));
  const own = yield* Layer.build(
    Keybindings.layer.pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-keybindings-here-" }),
      ),
      Layer.provide(NodeServices.layer),
    ),
  );
  const copying = yield* PeerKeybindings.layer.pipe(
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(Layer.succeedContext(own)),
    Layer.provide(FetchHttpClient.layer),
    Layer.build,
  );
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    keybindings: Context.get(own, Keybindings.Keybindings),
    keybindingsConfigPath: Context.get(own, ServerConfig.ServerConfig).keybindingsConfigPath,
    copy: Context.get(copying, PeerKeybindings.PeerKeybindings),
  };
});

const boxRules = [
  { key: "mod+shift+k", command: "commandPalette.toggle" },
  { key: "mod+alt+x", command: "a.command.from.a.newer.build" },
  { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
];
const laptopRules = [{ key: "mod+j", command: "terminal.toggle" }];

it.layer(NodeServices.layer)("PeerKeybindings", (it) => {
  it.effect("replaces this machine's keybindings with a linked one's and keeps a backup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveBox();
        const a = yield* makeLaptop;
        yield* writeJson(b.keybindingsConfigPath, boxRules);
        yield* writeJson(a.keybindingsConfigPath, laptopRules);
        // Read-only is the narrowest link there is, and it is enough.
        yield* linkTo(a.links, b, "read-only");

        const preview = yield* a.copy.preview({ environmentId: box.environmentId });
        expect(preview).toEqual({
          environmentId: box.environmentId,
          label: "Box",
          differing: 3,
          copyable: 2,
          skipped: 1,
        });

        const result = yield* a.copy.copy({ environmentId: box.environmentId });
        expect(result).toEqual({
          environmentId: box.environmentId,
          label: "Box",
          copied: 2,
          skipped: 1,
          backupPath: `${a.keybindingsConfigPath}.bak`,
        });
        expect(yield* readJson(a.keybindingsConfigPath)).toEqual([boxRules[0], boxRules[2]]);
        expect(yield* readJson(`${a.keybindingsConfigPath}.bak`)).toEqual(laptopRules);
        const state = yield* a.keybindings.getSnapshot;
        expect(state.keybindings.some((rule) => rule.command === "commandPalette.toggle")).toBe(
          true,
        );

        // Nothing differs now: the backup of the earlier file stays as it was.
        const again = yield* a.copy.copy({ environmentId: box.environmentId });
        expect(again).toMatchObject({ copied: 0, backupPath: null });
        expect(yield* readJson(`${a.keybindingsConfigPath}.bak`)).toEqual(laptopRules);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("names a linked machine too old to share its keybindings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveBox(descriptorOf("environment-box", "Box"));
        const a = yield* makeLaptop;
        yield* linkTo(a.links, b);
        const error = yield* Effect.flip(a.copy.preview({ environmentId: box.environmentId }));
        expect(error).toMatchObject({ _tag: "PeerLinkError", reason: "incompatible" });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("is refused by a linked machine with Linked environments off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveBox();
        const a = yield* makeLaptop;
        yield* writeJson(a.keybindingsConfigPath, laptopRules);
        yield* linkTo(a.links, b);
        yield* b.settings.updateSettings({ linkedEnvironmentsEnabled: false });
        const error = yield* Effect.flip(a.copy.copy({ environmentId: box.environmentId }));
        expect(error.message).toContain("refused");
        expect(yield* readJson(a.keybindingsConfigPath)).toEqual(laptopRules);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("asks nothing for a machine this one does not link to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* makeLaptop;
        const error = yield* Effect.flip(a.copy.preview({ environmentId: box.environmentId }));
        expect(error).toMatchObject({ _tag: "PeerLinkError", reason: "unknown_link" });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
