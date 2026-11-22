import {
  AuthSettingsWriteScope,
  isSecretReference,
  type SecretReference,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const EMPTY_TOKENS: Readonly<Record<string, SettingsSecretValue>> = {};

const hasToken = (token: SettingsSecretValue | undefined) =>
  typeof token === "string" ? token.length > 0 : token !== undefined;

/** A project's own GitHub token, used instead of the machine's credential for its requests. */
export function ProjectGitHubTokenSettings({
  members,
}: {
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const gt = useGT();
  return (
    <SettingsSection title={gt("GitHub")}>
      {members.map((member) => (
        <ProjectGitHubTokenRow
          key={`${member.environmentId}:${member.id}`}
          member={member}
          showEnvironment={members.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

function ProjectGitHubTokenRow({
  member,
  showEnvironment,
}: {
  readonly member: SidebarProjectGroupMember;
  readonly showEnvironment: boolean;
}) {
  const gt = useGT();
  const { environmentId, id: projectId } = member;
  const identity = useEnvironmentQuery(
    sourceControlEnvironment.projectGitHubIdentity({ environmentId, input: { projectId } }),
  );
  const entry = useEnvironmentSettings(
    environmentId,
    (settings) => settings.projectSettingsOverrides[projectId],
  );
  const tokens = entry?.gitHubTokens ?? EMPTY_TOKENS;
  const canWrite = useEnvironmentsWithScope([member], AuthSettingsWriteScope).has(environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save project GitHub token",
  });
  const secretSources = useSecretSources(environmentId);
  const host = identity.data?.host;
  const savedToken = host === undefined ? undefined : tokens[host];
  const isSaved = hasToken(savedToken);
  const sourceKey = JSON.stringify([host ?? "", savedToken ?? ""]);
  const [pending, setPending] = useState<{
    readonly key: string;
    readonly draft: string | SecretReference;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const draft =
    pending?.key === sourceKey ? pending.draft : isSecretReference(savedToken) ? savedToken : "";
  const submission = typeof draft === "string" ? draft.trim() : draft;

  const save = async (token: SettingsSecretValue) => {
    if (host === undefined) return;
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      // The whole entry goes back; redaction markers keep the values this client never sees.
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]: { ...entry, gitHubTokens: { ...tokens, [host]: token } },
          },
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setPending(null);
      identity.refresh();
    }
  };

  const login = identity.data?.login ?? null;
  const status =
    identity.data === null
      ? identity.error === null
        ? gt("Checking which GitHub account this project uses…")
        : gt("Could not check the GitHub account: {error}", { error: identity.error })
      : login !== null
        ? identity.data.source === "project"
          ? gt("Acts as {login} on {host} with this project's own token.", {
              login,
              host: identity.data.host,
            })
          : gt("Acts as {login} on {host} with this machine's GitHub credential.", {
              login,
              host: identity.data.host,
            })
        : identity.data.error !== null
          ? gt("Could not read the GitHub account on {host}: {error}", {
              host: identity.data.host,
              error: identity.data.error,
            })
          : gt("Uses this machine's GitHub credential.");

  return (
    <SettingsRow
      title={
        showEnvironment
          ? gt("GitHub token on {environment}", {
              environment: member.environmentLabel ?? gt("this machine"),
            })
          : gt("GitHub token")
      }
      description={gt(
        "Used instead of the machine's GitHub credential for this project's GitHub requests on the server, including the agents' pull request and CI tools. A token GitHub refuses fails those requests rather than falling back. Git fetch and push keep their own credentials.",
      )}
    >
      <form
        className="grid gap-2 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (submission !== "") void save(submission);
        }}
      >
        <fieldset disabled={saving || !canWrite || host === undefined} className="contents">
          <p role="status" className="text-xs text-muted-foreground">
            {status}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 sm:max-w-sm">
              <SecretSourceInput
                id={`project-github-token-${environmentId}-${projectId}`}
                size="sm"
                aria-label={gt("Project GitHub token")}
                environmentId={environmentId}
                configured={isSaved && !isSecretReference(savedToken)}
                value={draft}
                sources={secretSources}
                onChange={(event) => setPending({ key: sourceKey, draft: event.target.value })}
                onSecretChange={(secret) => setPending({ key: sourceKey, draft: secret ?? "" })}
              />
            </div>
            <Button type="submit" size="xs" disabled={submission === ""}>
              <T>Save</T>
            </Button>
            {isSaved ? (
              <Button size="xs" variant="outline" onClick={() => void save("")}>
                <T>Remove</T>
              </Button>
            ) : null}
            {host === undefined ? null : (
              <span className="text-xs">
                <InlineButton
                  render={
                    <a
                      href={`https://${host}/settings/personal-access-tokens/new`}
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  }
                >
                  <T>Create a token</T>
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </InlineButton>
              </span>
            )}
          </div>
        </fieldset>
      </form>
    </SettingsRow>
  );
}
