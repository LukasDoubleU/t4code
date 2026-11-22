import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as ProjectGitHubToken from "./projectGitHubToken.ts";

/** The real `ProjectGitHubTokens` over in-memory settings, project roots and thread worktrees. */
export function layer(input: {
  readonly settings: Partial<ServerSettings>;
  /** Workspace root to project id. */
  readonly roots?: Readonly<Record<string, string>>;
  /** Thread worktree path to project id. */
  readonly worktrees?: Readonly<Record<string, string>>;
  /** What each secret provider reference reads as; absent reads as unavailable. */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly onStoreRead?: () => void;
}) {
  return Layer.effect(ProjectGitHubToken.ProjectGitHubTokens, ProjectGitHubToken.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...input.settings }),
        }),
        Layer.mock(SecretResolver.SecretResolver)({
          read: (references) =>
            Effect.succeed(references.map(({ reference }) => input.secrets?.[reference])),
          label: (provider) => Effect.succeed(provider),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          findActiveByWorkspaceRoot: (root) =>
            Effect.sync(() => {
              input.onStoreRead?.();
              const projectId = input.roots?.[root];
              return projectId === undefined
                ? Option.none()
                : Option.some({ projectId: ProjectId.make(projectId) } as ProjectStore.ProjectRow);
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          readShellSnapshot: (options) =>
            Effect.sync(() => {
              input.onStoreRead?.();
              const projectId =
                options?.worktreePath === undefined
                  ? undefined
                  : input.worktrees?.[options.worktreePath];
              return Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads:
                  projectId === undefined
                    ? []
                    : [{ projectId: ProjectId.make(projectId) } as OrchestrationV2ThreadShell],
                archivedThreads: [],
              });
            }),
        }),
      ),
    ),
  );
}
