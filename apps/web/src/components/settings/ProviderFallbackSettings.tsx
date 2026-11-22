import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ProviderFallbackEntry,
  ProviderFallbackEntryState,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  describeBudget,
  describeStatus,
  entryKey,
  type FallbackChain,
  formatUsd,
  moveEntry,
  removeEntry,
  replaceEntry,
  statusForEntry,
  withBudgetField,
} from "./ProviderFallbackSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingSource,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

// Re-enabling lifts parking and cool-downs and checks a refused key again.
const reenableLabel: Partial<Record<ProviderFallbackEntryState, string>> = {
  parked: msg("Re-enable"),
  cooling: msg("Retry now"),
  refused: msg("Check again"),
};

/** The ordered chain a thread moves along when a provider's quota or budget runs out. */
export function ProviderFallbackSettings() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const canWrite = useScopedSettingsWriteAllowed();
  const { environment, target, scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const source = useScopedSettingSource(["providerFallbackChain"]);
  const mixed = useScopedSettingsMixed(["providerFallbackChain"]);
  const environmentId = environment?.serverConfig ? environment.environmentId : null;
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environmentId === null ? undefined : providersByEnvironment.get(environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const projectId = target?.projectId ?? null;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, projectId);
  const chain = settings.providerFallbackChain;
  const status = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.providerFallbackStatus({
          environmentId,
          input: projectId === null ? {} : { projectId },
        }),
  );
  const canReenable = useAtomValue(
    serverEnvironment.reenableProviderFallbackEntry.permissionAtom(environmentId),
  );
  const reenable = useAtomCommand(serverEnvironment.reenableProviderFallbackEntry, {
    label: "provider fallback re-enable",
  });
  const [reenabling, setReenabling] = useState<ProviderInstanceId | null>(null);
  const save = (next: FallbackChain) => updateSettings({ providerFallbackChain: next });
  const editable = canWrite && environmentId !== null;

  const taken = new Set(chain.map(entryKey));
  const modelsByInstance = getCustomModelOptionsByInstance(settings, providers);
  const nextNew = instanceEntries
    .filter((instance) => instance.enabled)
    .flatMap((instance) =>
      (modelsByInstance.get(instance.instanceId) ?? []).map((model) => ({
        instanceId: instance.instanceId,
        model: model.slug,
      })),
    )
    .find((candidate) => !taken.has(entryKey(candidate)));

  const changeEntry = (index: number, next: ProviderFallbackEntry) => {
    if (chain.some((other, at) => at !== index && entryKey(other) === entryKey(next))) {
      toastManager.add({
        type: "warning",
        title: gt("Already in the chain"),
        description: gt("{model} on this provider is entry {entry}.", {
          model: next.model,
          entry: chain.findIndex((other) => entryKey(other) === entryKey(next)) + 1,
        }),
      });
      return;
    }
    save(replaceEntry(chain, index, next));
  };

  const runReenable = async (instanceId: ProviderInstanceId) => {
    if (environmentId === null) return;
    setReenabling(instanceId);
    const result = await reenable({
      environmentId,
      input: projectId === null ? { instanceId } : { instanceId, projectId },
    });
    setReenabling(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not re-enable the entry"),
          description: String(squashAtomCommandFailure(result)),
        }),
      );
      return;
    }
    status.refresh();
  };

  const formatTime = (iso: string) => formatUpcomingTimestamp(iso, settings.timestampFormat);

  return (
    <SettingsSection
      {...setting("provider-fallback")}
      headerAction={
        editable ? (
          <Button
            size="xs"
            variant="outline"
            disabled={nextNew === undefined}
            onClick={() => nextNew && save([...chain, nextNew])}
          >
            <PlusIcon className="size-3" aria-hidden />
            <T>Add entry</T>
          </Button>
        ) : null
      }
    >
      <SettingsRow
        serverScoped
        settingKeys={["providerFallbackChain"]}
        title={gt("Fallback chain")}
        description={
          mixed
            ? gt(
                "The selected environments have different chains; a change here sets one chain on all of them.",
              )
            : isProjectScope
              ? gt(
                  "This project follows the environment's chain until you change it here. An empty chain turns fallback off for the project.",
                )
              : gt(
                  "When a provider's usage limit, credit or budget runs out, the thread continues on the next ready entry. Earlier entries take over again once they reset.",
                )
        }
        control={
          isProjectScope && source === "environment" && chain.length > 0 ? (
            <Button size="xs" variant="outline" onClick={() => save([])}>
              <T>Off for this project</T>
            </Button>
          ) : null
        }
      />
      {chain.length === 0 ? (
        <SettingsRow
          title={gt("No entries")}
          description={gt(
            "Fallback is off. Add an entry for each provider instance and model, in the order to try them.",
          )}
        />
      ) : null}
      <SettingsRow
        title={gt("Spending limits")}
        description={gt(
          "The limit on the API key itself, such as OpenRouter's, is the real safety net. OpenRouter keys without a limit are refused.",
        )}
      />
      {chain.map((entry, index) => (
        <FallbackEntryRow
          key={entryKey(entry)}
          entry={entry}
          index={index}
          count={chain.length}
          editable={editable}
          environmentId={environmentId}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={getCustomModelOptionsByInstance(
            settings,
            providers,
            entry.instanceId,
            entry.model,
          )}
          status={statusForEntry(status.data?.entries ?? [], entry)}
          formatTime={formatTime}
          canReenable={canReenable && reenabling === null}
          onReenable={() => void runReenable(entry.instanceId)}
          onChange={(next) => changeEntry(index, next)}
          onMove={(offset) => save(moveEntry(chain, index, offset))}
          onRemove={() => save(removeEntry(chain, index))}
        />
      ))}
    </SettingsSection>
  );
}

function FallbackEntryRow({
  entry,
  index,
  count,
  editable,
  environmentId,
  instanceEntries,
  modelOptionsByInstance,
  status,
  formatTime,
  canReenable,
  onReenable,
  onChange,
  onMove,
  onRemove,
}: {
  readonly entry: ProviderFallbackEntry;
  readonly index: number;
  readonly count: number;
  readonly editable: boolean;
  readonly environmentId: Parameters<typeof ProviderModelPicker>[0]["environmentId"];
  readonly instanceEntries: Parameters<typeof ProviderModelPicker>[0]["instanceEntries"];
  readonly modelOptionsByInstance: Parameters<
    typeof ProviderModelPicker
  >[0]["modelOptionsByInstance"];
  readonly status: ReturnType<typeof statusForEntry>;
  readonly formatTime: (iso: string) => string;
  readonly canReenable: boolean;
  readonly onReenable: () => void;
  readonly onChange: (next: ProviderFallbackEntry) => void;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const instance = instanceEntries.find((candidate) => candidate.instanceId === entry.instanceId);
  const described = status === undefined ? null : describeStatus(status, formatTime, m);
  const budget = status === undefined ? null : describeBudget(status, m);
  const setBudgetField = (field: "monthlyUsd" | "perRunUsd" | "group", text: string) => {
    const next = withBudgetField(entry, field, text);
    if (next !== null) onChange(next);
  };

  return (
    <SettingsRow
      title={`${index + 1}. ${instance?.displayName ?? entry.instanceId}`}
      description={entry.model}
      status={
        described === null && budget === null ? null : (
          <span className="flex flex-wrap items-center gap-2">
            {described === null ? null : <Badge variant={described.tone}>{described.label}</Badge>}
            {described?.detail ? <span>{described.detail}</span> : null}
            {budget === null ? null : <span>{budget}</span>}
            {status === undefined || reenableLabel[status.state] === undefined ? null : (
              <Button size="xs" variant="outline" disabled={!canReenable} onClick={onReenable}>
                {m(reenableLabel[status.state]!)}
              </Button>
            )}
          </span>
        )
      }
      control={
        editable ? (
          <div className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Move up")}
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Move down")}
              disabled={index === count - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Remove entry")}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          </div>
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <ProviderModelPicker
          environmentId={environmentId}
          activeInstanceId={entry.instanceId}
          model={entry.model}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          disabled={!editable}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          onInstanceModelChange={(instanceId, model) => {
            if (instanceId === entry.instanceId && model === entry.model) return;
            // Another provider's key has its own budget, so a budget stays with its instance.
            onChange(instanceId === entry.instanceId ? { ...entry, model } : { instanceId, model });
          }}
        />
        <DraftInput
          size="sm"
          className="w-28"
          inputMode="decimal"
          disabled={!editable}
          value={entry.budget === undefined ? "" : String(entry.budget.monthlyUsd)}
          onCommit={(text) => setBudgetField("monthlyUsd", text)}
          placeholder={gt("Monthly USD")}
          aria-label={gt("Monthly budget for entry {entry}", { entry: index + 1 })}
        />
        <DraftInput
          size="sm"
          className="w-28"
          inputMode="decimal"
          disabled={!editable}
          value={entry.budget === undefined ? "" : String(entry.budget.perRunUsd)}
          onCommit={(text) => setBudgetField("perRunUsd", text)}
          placeholder={gt("Per run USD")}
          aria-label={gt("Per-run budget for entry {entry}", { entry: index + 1 })}
        />
        <DraftInput
          size="sm"
          className="w-36"
          disabled={!editable || entry.budget === undefined}
          value={entry.budget?.group ?? ""}
          onCommit={(text) => setBudgetField("group", text)}
          placeholder={gt("Budget group")}
          aria-label={gt("Budget group for entry {entry}", { entry: index + 1 })}
        />
        {entry.budget === undefined ? null : (
          <span className="text-xs text-muted-foreground">
            <T>
              Up to <Var>{formatUsd(entry.budget.perRunUsd)}</Var> a run
            </T>
          </span>
        )}
      </div>
    </SettingsRow>
  );
}
