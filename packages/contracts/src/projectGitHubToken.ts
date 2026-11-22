import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProjectGitHubIdentityInput = Schema.Struct({ projectId: ProjectId });
export type ProjectGitHubIdentityInput = typeof ProjectGitHubIdentityInput.Type;

/** The GitHub account a project's server-side GitHub requests act as. */
export const ProjectGitHubIdentity = Schema.Struct({
  /** The host the project's GitHub requests go to, which its own token is saved for. */
  host: TrimmedNonEmptyString,
  /** `project` when the project's own token is used, else the machine's credential. */
  source: Schema.Literals(["project", "machine"]),
  login: Schema.NullOr(Schema.String),
  /** Why the login could not be read, such as a token GitHub refused. */
  error: Schema.NullOr(Schema.String),
});
export type ProjectGitHubIdentity = typeof ProjectGitHubIdentity.Type;
