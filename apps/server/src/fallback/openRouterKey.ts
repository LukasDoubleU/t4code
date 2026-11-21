import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

/** An OpenCode or Pi entry whose model OpenRouter serves. */
export const isOpenRouterEntry = (driver: string, model: string) =>
  (driver === "opencode" || driver === "pi") && model.toLowerCase().startsWith("openrouter/");

export type OpenRouterKeyCheck =
  | { readonly ok: true; readonly limitUsd: number; readonly remainingUsd: number | null }
  | { readonly ok: false; readonly reason: string; readonly retry: boolean };

const KeyResponse = Schema.Struct({
  data: Schema.Struct({
    limit: Schema.optional(Schema.NullOr(Schema.Number)),
    limit_remaining: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});
const decodeKeyResponse = Schema.decodeUnknownOption(KeyResponse);

export const NO_KEY =
  "T4 could not find this entry's OpenRouter key to check its limit. Set OPENROUTER_API_KEY in the provider instance's environment variables.";
export const NO_LIMIT =
  "This OpenRouter key has no credit limit, so nothing caps what it spends. Give the key a limit on openrouter.ai, then it can join the chain.";

/** Reads `GET /api/v1/key`'s answer; a key without a `limit` is refused. */
export function readKeyCheck(status: number, body: unknown): OpenRouterKeyCheck {
  if (status === 401 || status === 403) {
    return { ok: false, reason: "OpenRouter rejected this entry's key.", retry: false };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      reason: `OpenRouter answered the key check with HTTP ${status}.`,
      retry: true,
    };
  }
  const decoded = decodeKeyResponse(body);
  if (decoded._tag === "None") {
    return {
      ok: false,
      reason: "OpenRouter's key check answered in an unknown form.",
      retry: true,
    };
  }
  const { limit, limit_remaining } = decoded.value.data;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) {
    return { ok: false, reason: NO_LIMIT, retry: false };
  }
  return { ok: true, limitUsd: limit, remainingUsd: limit_remaining ?? null };
}

export const checkOpenRouterKey = Effect.fn("ProviderFallback.checkOpenRouterKey")(function* (
  key: string,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(
      HttpClientRequest.get("https://openrouter.ai/api/v1/key").pipe(
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.acceptJson,
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((body) => readKeyCheck(response.status, body)),
        ),
      ),
      Effect.timeout(10_000),
      // The key never reaches the log or the reason: only that the check failed.
      Effect.catchCause(() =>
        Effect.succeed<OpenRouterKeyCheck>({
          ok: false,
          reason: "T4 could not reach OpenRouter to check this key's limit.",
          retry: true,
        }),
      ),
    );
});

const AuthFile = Schema.Record(Schema.String, Schema.Unknown);
const decodeAuthFile = Schema.decodeUnknownOption(Schema.fromJsonString(AuthFile));

const keyIn = (contents: string | null): string | null => {
  if (contents === null) return null;
  const auth = decodeAuthFile(contents);
  if (auth._tag === "None") return null;
  const entry = auth.value.openrouter;
  if (entry === null || typeof entry !== "object") return null;
  const key = (entry as { readonly key?: unknown }).key;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : null;
};

/**
 * The key an entry's CLI would use: the instance's environment first, then the CLI's own auth
 * store (OpenCode's `auth.json`, Pi's `~/.pi/agent/auth.json`).
 */
export const readOpenRouterKey = Effect.fn("ProviderFallback.readOpenRouterKey")(function* (
  driver: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const fromEnvironment = environment.OPENROUTER_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
  const file =
    driver === "opencode"
      ? path.join(
          environment.XDG_DATA_HOME || path.join(home, ".local", "share"),
          "opencode",
          "auth.json",
        )
      : path.join(environment.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), "auth.json");
  const contents =
    driver === "opencode" && environment.OPENCODE_AUTH_CONTENT
      ? environment.OPENCODE_AUTH_CONTENT
      : yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  return keyIn(contents);
});
