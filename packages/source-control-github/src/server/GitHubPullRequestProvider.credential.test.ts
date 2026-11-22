import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { ProjectCredential } from "@t3tools/source-control-core/server/ProjectCredential";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubAppAccess from "./GitHubAppAccess.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";

const appSignedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
  enabled: false,
  token: () => Effect.succeedNone,
  invalidate: () => Effect.void,
});

const makeProvider = (
  credentials: Layer.Layer<GitHubCredentials.GitHubCredentials>,
  http: Layer.Layer<HttpClient.HttpClient>,
) =>
  GitHubPullRequestProvider.make.pipe(
    Effect.provide(
      GitHubPullRequestApi.layer.pipe(
        Layer.provideMerge(GitHubAppAccess.layer),
        // GraphQL reads go over `http` too, through the same credential and quota as REST.
        Layer.provide(
          GitHubRest.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(credentials, http, appSignedOut)),
            Layer.provideMerge(GitHubQuota.layer),
            Layer.provideMerge(SourceControlRateLimit.layer),
          ),
        ),
        Layer.provide(TestSourceControlHost.layer()),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

it.effect("keeps branch deletion on the credential that passed source repository permissions", () =>
  Effect.gen(function* () {
    let activeToken = "account-a";
    const requests: Array<{ operation: string; authorization: string | undefined }> = [];
    const credentials = Layer.succeed(
      GitHubCredentials.GitHubCredentials,
      GitHubCredentials.GitHubCredentials.of({
        get: (host) =>
          Effect.sync(() => ({
            host,
            token: Redacted.make(activeToken),
            source: "gh" as const,
            fingerprint: `${host}:${activeToken}`,
          })),
        saved: () => Effect.succeedNone,
        fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
        invalidate: () => Effect.void,
      }),
    );
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const operation = request.url.endsWith("/user")
            ? "user"
            : request.body._tag === "Uint8Array"
              ? new TextDecoder().decode(request.body.body)
              : "";
          requests.push({ operation, authorization: request.headers["authorization"] });
          let body;
          if (operation === "user") {
            body = { id: activeToken === "account-a" ? 101 : 202, login: activeToken };
          } else if (operation.includes("query PullRequestBranchToDelete")) {
            body = {
              data: {
                repository: {
                  pullRequest: {
                    state: "MERGED",
                    headRefName: "feature",
                    baseRefName: "main",
                    headRefOid: "abc123",
                    headRepository: { id: "FORK_REPO" },
                  },
                },
              },
            };
          } else if (operation.includes("query PullRequestSourceBranch")) {
            body = {
              data: {
                node: {
                  __typename: "Repository",
                  defaultBranchRef: { name: "main" },
                  ref: { target: { __typename: "Commit", oid: "abc123" } },
                },
              },
            };
          } else if (operation.includes("updateRefs(")) {
            body = { data: { updateRefs: { clientMutationId: null } } };
          } else {
            // The credential rotates the moment the permission read is answered.
            activeToken = "account-b";
            body = {
              data: {
                repository: {
                  mergeCommitAllowed: true,
                  squashMergeAllowed: true,
                  rebaseMergeAllowed: true,
                  autoMergeAllowed: true,
                  viewerPermission: "READ",
                  pullRequest: {
                    viewerCanUpdate: false,
                    viewerDidAuthor: false,
                    headRepository: { viewerPermission: "WRITE" },
                  },
                },
              },
            };
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    );
    const provider = yield* makeProvider(credentials, http);
    const reference = { cwd: "/a", repository: "acme/web", host: "github.com", number: 1 };
    assert.isDefined(provider.withVerifiedCredential);
    yield* provider.withVerifiedCredential!({ cwd: "/a", host: "github.com" }, () =>
      Effect.gen(function* () {
        const permissions = yield* provider.getViewerPermissions({
          ...reference,
          includeUpdateBranch: false,
        });
        assert.include(permissions.actions, "delete-branch");
        yield* provider.runAction({ ...reference, action: "delete-branch" });
      }),
    );

    assert.strictEqual(activeToken, "account-b");
    assert.strictEqual(
      requests.filter(({ operation }) => operation.includes("updateRefs(")).length,
      1,
    );
    assert.deepStrictEqual(
      requests.map(({ authorization }) => authorization),
      [
        "Bearer account-a",
        "Bearer account-a",
        "Bearer account-a",
        "Bearer account-a",
        "Bearer account-a",
      ],
    );
  }),
);

it.effect("names a refused project token when the verified login is read with it", () =>
  Effect.gen(function* () {
    const sent: Array<string | undefined> = [];
    const credentials = Layer.succeed(
      GitHubCredentials.GitHubCredentials,
      GitHubCredentials.GitHubCredentials.of({
        get: (host) =>
          Effect.succeed({
            host,
            token: Redacted.make("machine"),
            source: "gh" as const,
            fingerprint: `${host}:machine`,
          }),
        saved: () => Effect.succeedNone,
        fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
        invalidate: () => Effect.void,
      }),
    );
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          sent.push(request.headers["authorization"]);
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }));
        }),
      ),
    );
    const provider = yield* makeProvider(credentials, http);
    const error = yield* Effect.flip(provider.getViewer({ cwd: "/a", host: "github.com" })).pipe(
      Effect.provideService(ProjectCredential, {
        projectId: "project-1",
        tokenFor: () => Effect.succeedSome(Redacted.make("project-token")),
      }),
    );
    assert.strictEqual(error.reason, "failed");
    assert.include(error.detail, "this project's own token");
    assert.notInclude(error.detail, "project-token");
    assert.deepStrictEqual(sent, ["Bearer project-token"]);
  }),
);
