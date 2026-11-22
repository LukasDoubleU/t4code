import type { SettingsSecretUnresolvedError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

/**
 * The project a forge request is made for, when that project carries its own token. A driver
 * asks it before any machine credential, and a refused project token never falls back to one.
 */
export interface ProjectCredential {
  readonly projectId: string;
  /** The project's own token for `host`; none sends the request with the machine credential. */
  readonly tokenFor: (
    host: string,
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, SettingsSecretUnresolvedError>;
}

export const ProjectCredential = Context.Reference<ProjectCredential | null>(
  "@t3tools/source-control-core/server/ProjectCredential",
  { defaultValue: () => null },
);
