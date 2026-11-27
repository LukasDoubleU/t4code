import {
  EnvironmentHttpApi,
  type KeybindingsConfigError,
  type PeerLinkKeybindingsCopyResult,
  type PeerLinkKeybindingsInput,
  type PeerLinkKeybindingsPreview,
  type PeerLinkKeybindingsSnapshot,
  PeerLinkError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Keybindings from "../keybindings.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerLinks from "./PeerLinks.ts";

const KeybindingsApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.peerLink)
  .annotateMerge(EnvironmentHttpApi.annotations);

export class PeerKeybindingsRefused extends Schema.TaggedError<PeerKeybindingsRefused>()(
  "PeerKeybindingsRefused",
  { message: Schema.String },
) {}

/** The linked side: hands an environment that links here this one's keybindings file. */
export class PeerKeybindingsSource extends Context.Service<
  PeerKeybindingsSource,
  {
    readonly read: (
      caller: EnvironmentAuth.McpClientSession,
    ) => Effect.Effect<
      PeerLinkKeybindingsSnapshot,
      PeerKeybindingsRefused | KeybindingsConfigError
    >;
  }
>()("t3/peer/PeerKeybindings/PeerKeybindingsSource") {}

/** The linking side: copies the keybindings of an environment this one links to, once. */
export class PeerKeybindings extends Context.Service<
  PeerKeybindings,
  {
    readonly preview: (
      input: PeerLinkKeybindingsInput,
    ) => Effect.Effect<PeerLinkKeybindingsPreview, PeerLinkError | KeybindingsConfigError>;
    readonly copy: (
      input: PeerLinkKeybindingsInput,
    ) => Effect.Effect<PeerLinkKeybindingsCopyResult, PeerLinkError | KeybindingsConfigError>;
  }
>()("t3/peer/PeerKeybindings") {}

const makeSource = Effect.gen(function* () {
  const keybindings = yield* Keybindings.Keybindings;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );

  const read: PeerKeybindingsSource["Service"]["read"] = Effect.fn("PeerKeybindingsSource.read")(
    function* (caller) {
      if (!(yield* enabled)) {
        return yield* new PeerKeybindingsRefused({ message: PeerLinks.LINKED_ENVIRONMENTS_OFF });
      }
      // Any link may read them: shortcuts hold nothing a read-only link could not already see.
      if (!caller.peerLink) {
        return yield* new PeerKeybindingsRefused({
          message: "Only a linked environment may read keybindings here.",
        });
      }
      return { entries: yield* keybindings.readFileEntries };
    },
  );

  return PeerKeybindingsSource.of({ read });
});

export const layerSource = Layer.effect(PeerKeybindingsSource, makeSource);

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const keybindings = yield* Keybindings.Keybindings;
  const httpClient = yield* HttpClient.HttpClient;

  const fetchEntries = Effect.fn("PeerKeybindings.fetchEntries")(function* (
    input: PeerLinkKeybindingsInput,
  ) {
    if (!(yield* links.enabled)) {
      return yield* new PeerLinkError({
        reason: "disabled",
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    const stored = yield* links.get(input.environmentId);
    if (Option.isNone(stored)) {
      return yield* new PeerLinkError({
        reason: "unknown_link",
        message: "This environment is no longer linked to that one.",
      });
    }
    const { label, expiresAt } = stored.value;
    if (DateTime.isLessThanOrEqualTo(expiresAt, yield* DateTime.now)) {
      return yield* new PeerLinkError({
        reason: "expired",
        message: `The link to ${label} expired. Link it again with a new pairing code from ${label}.`,
      });
    }
    const peer = yield* links.resolve(input.environmentId);
    if (peer.capabilities.linkKeybindings !== true) {
      return yield* new PeerLinkError({
        reason: "incompatible",
        message: `${peer.link.label} runs a version that cannot share its keybindings. Update it first.`,
      });
    }
    const api = yield* HttpApiClient.make(KeybindingsApi, { baseUrl: peer.url }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    const snapshot = yield* api.peerLink
      .keybindings({ headers: { authorization: `Bearer ${peer.token}` } })
      .pipe(
        Effect.timeout(PeerLinks.probeTimeout(peer.url)),
        Effect.mapError(
          (cause) =>
            new PeerLinkError({
              reason: "unreachable",
              message:
                cause._tag === "EnvironmentHttpForbiddenError"
                  ? `${peer.link.label} refused: ${cause.message}`
                  : `${peer.link.label} did not share its keybindings.`,
              cause,
            }),
        ),
      );
    return { label: peer.link.label, entries: snapshot.entries };
  });

  const preview: PeerKeybindings["Service"]["preview"] = Effect.fn("PeerKeybindings.preview")(
    function* (input) {
      const { label, entries } = yield* fetchEntries(input);
      const preview = yield* keybindings.previewReplace(entries);
      return { environmentId: input.environmentId, label, ...preview };
    },
  );

  const copy: PeerKeybindings["Service"]["copy"] = Effect.fn("PeerKeybindings.copy")(
    function* (input) {
      const { label, entries } = yield* fetchEntries(input);
      const result = yield* keybindings.replaceWithEntries(entries);
      return {
        environmentId: input.environmentId,
        label,
        copied: result.differing === 0 ? 0 : result.copyable,
        skipped: result.skipped,
        backupPath: result.backupPath,
      };
    },
  );

  return PeerKeybindings.of({ preview, copy });
});

export const layer = Layer.effect(PeerKeybindings, make);
