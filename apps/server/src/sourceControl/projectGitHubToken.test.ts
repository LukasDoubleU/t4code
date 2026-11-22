import { ProjectId, SecretProviderId, type ServerSettings } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ProjectGitHubToken from "./projectGitHubToken.ts";
import * as ProjectGitHubTokenTestkit from "./projectGitHubToken.testkit.ts";

const P1 = ProjectId.make("project-1");
const P2 = ProjectId.make("project-2");

const withTokens = (
  overrides: ServerSettings["projectSettingsOverrides"],
  sourceControlHosts: ServerSettings["sourceControlHosts"] = {},
): Partial<ServerSettings> => ({ projectSettingsOverrides: overrides, sourceControlHosts });

const tokenFor = (cwd: string, host: string) =>
  Effect.gen(function* () {
    const tokens = yield* ProjectGitHubToken.ProjectGitHubTokens;
    const credential = yield* tokens.forCwd(cwd);
    if (credential === null) return "machine";
    const token = yield* credential.tokenFor(host);
    return Option.match(token, { onNone: () => "machine", onSome: Redacted.value });
  });

describe("ProjectGitHubTokens", () => {
  it.effect("gives a project's checkout and thread worktrees its token, on its hosts only", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* tokenFor("/work/one", "github.com"), "p1-token");
      assert.strictEqual(yield* tokenFor("/worktrees/one-feature", "github.com"), "p1-token");
      assert.strictEqual(yield* tokenFor("/work/one", "GitHub.com"), "p1-token");
      assert.strictEqual(yield* tokenFor("/work/one", "ghe.acme.test"), "machine");
      // A host turned off in Settings stays off for the project too.
      assert.strictEqual(yield* tokenFor("/work/one", "off.acme.test"), "machine");
      assert.strictEqual(yield* tokenFor("/work/two", "github.com"), "machine");
      assert.strictEqual(yield* tokenFor("/elsewhere", "github.com"), "machine");
    }).pipe(
      Effect.provide(
        ProjectGitHubTokenTestkit.layer({
          settings: withTokens(
            {
              [P1]: { gitHubTokens: { "github.com": "p1-token", "off.acme.test": "p1-off" } },
              [P2]: { gitHubTokens: { "github.com": "" } },
            },
            { github: { hosts: { "off.acme.test": { enabled: false } } } },
          ),
          roots: { "/work/one": P1, "/work/two": P2 },
          worktrees: { "/worktrees/one-feature": P1 },
        }),
      ),
    ),
  );

  it.effect("looks up no checkout while no project has a token", () => {
    let reads = 0;
    return Effect.gen(function* () {
      assert.strictEqual(yield* tokenFor("/work/one", "github.com"), "machine");
      assert.strictEqual(reads, 0);
    }).pipe(
      Effect.provide(
        ProjectGitHubTokenTestkit.layer({
          settings: withTokens({ [P1]: { defaultAutoPull: true } }),
          roots: { "/work/one": P1 },
          onStoreRead: () => reads++,
        }),
      ),
    );
  });

  it.effect("fails, rather than use the machine's, when the token's secret cannot be read", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(tokenFor("/work/one", "github.com"));
      assert.strictEqual(error._tag, "SettingsSecretUnresolvedError");
      assert.strictEqual(yield* tokenFor("/work/two", "github.com"), "from-vault");
    }).pipe(
      Effect.provide(
        ProjectGitHubTokenTestkit.layer({
          settings: withTokens({
            [P1]: {
              gitHubTokens: {
                "github.com": { provider: SecretProviderId.make("vault"), reference: "locked" },
              },
            },
            [P2]: {
              gitHubTokens: {
                "github.com": { provider: SecretProviderId.make("vault"), reference: "open" },
              },
            },
          }),
          roots: { "/work/one": P1, "/work/two": P2 },
          secrets: { open: "from-vault" },
        }),
      ),
    ),
  );
});
