import type { ProjectGitHubIdentity, ProjectGitHubIdentityInput } from "@t3tools/contracts";
import { ProjectCredential } from "@t3tools/source-control-core/server/ProjectCredential";
import * as GitHubClient from "@t3tools/source-control-github/shared/definition";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as BuiltInDrivers from "./builtInDrivers.ts";
import * as ProjectGitHubTokens from "./projectGitHubToken.ts";
import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

const GITHUB = GitHubClient.definition.kind;
const DEFAULT_HOST = "github.com";

/** Which GitHub account a project's requests act as, for its settings page. */
export class ProjectGitHubIdentityService extends Context.Service<
  ProjectGitHubIdentityService,
  {
    readonly read: (input: ProjectGitHubIdentityInput) => Effect.Effect<ProjectGitHubIdentity>;
  }
>()("t3/sourceControl/projectGitHubIdentity/ProjectGitHubIdentityService") {}

const make = Effect.gen(function* () {
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const tokens = yield* ProjectGitHubTokens.ProjectGitHubTokens;
  const pullRequests = drivers.find(({ driver }) => driver.kind === GITHUB)?.instance.pullRequests;

  return ProjectGitHubIdentityService.of({
    read: Effect.fn("ProjectGitHubIdentity.read")(function* ({ projectId }) {
      const project = Option.getOrUndefined(
        yield* projects.getShell(projectId).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      const identity = project?.repositoryIdentity;
      const host =
        identity != null && identity.provider === GITHUB
          ? sourceControlDefinitions.changeRequestHost(identity, GITHUB)
          : DEFAULT_HOST;
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      const source =
        Option.isSome(settings) &&
        ProjectGitHubTokens.projectGitHubToken(settings.value, projectId, host) !== undefined
          ? ("project" as const)
          : ("machine" as const);
      if (project === undefined || pullRequests == null) {
        return { host, source, login: null, error: null } satisfies ProjectGitHubIdentity;
      }
      // The provider keeps the login per credential, so reopening the page sends nothing new.
      const login = yield* pullRequests
        .getViewer({ cwd: project.workspaceRoot, host })
        .pipe(
          Effect.provideService(ProjectCredential, tokens.forProject(projectId)),
          Effect.result,
        );
      return {
        host,
        source,
        login: login._tag === "Success" ? login.success : null,
        error: login._tag === "Failure" ? login.failure.detail : null,
      } satisfies ProjectGitHubIdentity;
    }),
  });
});

export const layer = Layer.effect(ProjectGitHubIdentityService, make).pipe(
  Layer.provide(Layer.merge(BuiltInDrivers.layer, ProjectGitHubTokens.layer)),
);
