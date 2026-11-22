import { type ProjectId, type ServerSettings, type SettingsSecretValue } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import type { SourceControlDriverInstance } from "@t3tools/source-control-core/server/driver";
import { ProjectCredential } from "@t3tools/source-control-core/server/ProjectCredential";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as GitHubClient from "@t3tools/source-control-github/shared/definition";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettingsService from "../serverSettings.ts";

const GITHUB = GitHubClient.definition.kind;

/** The project's own token for `host`, as saved: a literal or a secret reference. */
export function projectGitHubToken(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: string,
  host: string,
): SettingsSecretValue | undefined {
  const tokens = settings.projectSettingsOverrides[projectId as ProjectId]?.gitHubTokens ?? {};
  const wanted = host.trim().toLowerCase();
  const found = Object.entries(tokens).find(([key]) => key.trim().toLowerCase() === wanted)?.[1];
  return found === "" ? undefined : found;
}

function projectsWithTokens(settings: ServerSettings): ReadonlySet<string> {
  return new Set(
    Object.entries(settings.projectSettingsOverrides).flatMap(([projectId, entry]) =>
      Object.values(entry.gitHubTokens ?? {}).some((token) => token !== "") ? [projectId] : [],
    ),
  );
}

function hostDisabled(settings: ServerSettings, host: string): boolean {
  return (
    readSourceControlHostSettings(GitHubClient.settings, settings.sourceControlHosts[GITHUB]).hosts[
      host
    ]?.enabled === false
  );
}

type Method = (...args: ReadonlyArray<unknown>) => unknown;

function cwdOf(input: unknown): string | undefined {
  return typeof input === "object" &&
    input !== null &&
    "cwd" in input &&
    typeof input.cwd === "string"
    ? input.cwd
    : undefined;
}

/** GitHub requests made for a project that carries its own token, with that token. */
export class ProjectGitHubTokens extends Context.Service<
  ProjectGitHubTokens,
  {
    /** The project credential of `projectId`; it holds a token only for hosts saved for it. */
    readonly forProject: (projectId: string) => ProjectCredential;
    /** The credential for requests made from `cwd`; null sends them with the machine's. */
    readonly forCwd: (cwd: string) => Effect.Effect<ProjectCredential | null>;
    /** `instance` with every request whose input names a `cwd` scoped to that cwd's project. */
    readonly scope: (instance: SourceControlDriverInstance) => SourceControlDriverInstance;
  }
>()("t3/sourceControl/projectGitHubToken/ProjectGitHubTokens") {}

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;

  const forProject = (projectId: string): ProjectCredential => ({
    projectId,
    tokenFor: Effect.fnUntraced(function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      // Settings that cannot be read must not pass for "no project token".
      const settings = yield* Effect.orDie(serverSettings.getSettings);
      // A host turned off stays off; the machine credential lookup reports it.
      if (hostDisabled(settings, host)) return Option.none();
      const saved = projectGitHubToken(settings, projectId, host);
      if (saved === undefined) return Option.none();
      const token = (yield* requireSettingsSecret(secrets, saved)).trim();
      return token === "" ? Option.none() : Option.some(Redacted.make(token));
    }),
  });

  // A checkout's project does not change; a miss is not kept, so a new worktree is found soon.
  const projectOfCwd = yield* Cache.makeWith(
    Effect.fnUntraced(function* (cwd: string) {
      const project = yield* projects.findActiveByWorkspaceRoot(cwd);
      if (Option.isSome(project)) return project.value.projectId as string;
      const snapshot = yield* Effect.flatten(threads.readShellSnapshot({ worktreePath: cwd }));
      return [...snapshot.threads, ...snapshot.archivedThreads][0]?.projectId ?? null;
    }),
    {
      capacity: 512,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? Duration.minutes(10) : Duration.zero,
    },
  );

  const forCwd = (cwd: string): Effect.Effect<ProjectCredential | null> =>
    serverSettings.getSettings.pipe(
      // Without readable settings no project token is known, as for the machine's saved token.
      Effect.orElseSucceed(() => null),
      Effect.flatMap((settings) => {
        const withTokens = settings === null ? new Set<string>() : projectsWithTokens(settings);
        if (withTokens.size === 0) return Effect.succeed(null);
        return Cache.get(projectOfCwd, cwd).pipe(
          // A lookup that fails must not send the project's requests as the machine.
          Effect.orDie,
          Effect.map((projectId) =>
            projectId !== null && withTokens.has(projectId) ? forProject(projectId) : null,
          ),
        );
      }),
    );

  const provideFor = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    forCwd(cwd).pipe(
      Effect.flatMap((credential) =>
        credential === null ? effect : Effect.provideService(effect, ProjectCredential, credential),
      ),
    );

  const scoped =
    (method: Method): Method =>
    (...args) => {
      const result = method(...args);
      const cwd = cwdOf(args[0]);
      if (cwd === undefined) return result;
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- each method keeps its own types.
      if (Effect.isEffect(result)) return provideFor(cwd, result);
      if (Stream.isStream(result)) {
        return Stream.unwrap(
          forCwd(cwd).pipe(
            Effect.map((credential) =>
              credential === null
                ? result
                : Stream.provideService(result, ProjectCredential, credential),
            ),
          ),
        );
      }
      return result;
    };

  const scopeMethods = <T extends object>(api: T): T =>
    Object.fromEntries(
      Object.entries(api).map(([name, member]) => [
        name,
        typeof member === "function" ? scoped(member as Method) : member,
      ]),
    ) as T;

  const scope = (instance: SourceControlDriverInstance): SourceControlDriverInstance => ({
    ...instance,
    sourceControl: scopeMethods(instance.sourceControl),
    pullRequests: instance.pullRequests === null ? null : scopeMethods(instance.pullRequests),
    ...(instance.issues === undefined ? {} : { issues: scopeMethods(instance.issues) }),
    ...(instance.fetchMedia === undefined
      ? {}
      : { fetchMedia: scoped(instance.fetchMedia as Method) as typeof instance.fetchMedia }),
  });

  return ProjectGitHubTokens.of({ forProject, forCwd, scope });
});

export const layer = Layer.effect(ProjectGitHubTokens, make).pipe(
  Layer.provide(Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer)),
  Layer.provide(SecretResolverLayer.layer),
);
