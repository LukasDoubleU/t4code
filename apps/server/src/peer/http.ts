import {
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PeerClientPairing from "./PeerClientPairing.ts";
import * as PeerKeybindings from "./PeerKeybindings.ts";

// The response is a credential.
const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

/**
 * A link session is accepted on `/mcp` and here, nowhere else. This is a route and not an MCP
 * tool so that no agent's tool list can hold it: thread credentials never authenticate here.
 */
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "peerLink",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const issuer = yield* PeerClientPairing.PeerClientPairingIssuer;
    const keybindings = yield* PeerKeybindings.PeerKeybindingsSource;
    const authenticateLink = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // A browser never holds a link's token; refuse one before reading credentials, as `/mcp` does.
      if (request.headers.origin !== undefined) {
        return yield* new EnvironmentHttpForbiddenError({
          message: "This route does not accept browser requests.",
        });
      }
      return yield* auth.authenticateMcpClient(request).pipe(
        Effect.mapError((error) =>
          EnvironmentAuth.isServerAuthCredentialError(error)
            ? new EnvironmentHttpUnauthorizedError({
                message: "Only a linked environment's session is accepted here.",
              })
            : new EnvironmentHttpInternalServerError({
                message: "The session could not be checked.",
              }),
        ),
      );
    });
    return handlers
      .handle(
        "keybindings",
        Effect.fn("environment.peerLink.keybindings")(function* () {
          const caller = yield* authenticateLink;
          return yield* keybindings.read(caller).pipe(
            Effect.catchTags({
              PeerKeybindingsRefused: (error) =>
                Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
              KeybindingsConfigParseError: () =>
                Effect.fail(
                  new EnvironmentHttpInternalServerError({
                    message: "The keybindings file could not be read.",
                  }),
                ),
            }),
          );
        }),
      )
      .handle(
        "clientPairing",
        Effect.fn("environment.peerLink.clientPairing")(function* (args) {
          yield* noStore;
          const caller = yield* authenticateLink;
          return yield* issuer.issue(caller, args.payload).pipe(
            Effect.catchTags({
              PeerClientPairingRefused: (error) =>
                Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            }),
            Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (cause) =>
              Effect.logError("Could not mint a client pairing for a linked environment.", {
                cause,
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new EnvironmentHttpInternalServerError({
                      message: "The pairing could not be created.",
                    }),
                  ),
                ),
              ),
            ),
          );
        }),
      );
  }),
);
