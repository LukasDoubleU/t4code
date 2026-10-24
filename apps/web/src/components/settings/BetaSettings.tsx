import { IDLE_COMPACTION_MODES, globalIdleCompaction } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { scopedIdleCompaction } from "./scopedSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function BetaSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedReviewGuidesEnabled = useScopedSettingsMixed(["reviewGuidesEnabled"]);
  const { targets } = useSettingsScope();
  const idleCompaction = scopedIdleCompaction(targets.length > 0 ? targets : [{ settings }]);

  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title="Beta features">
        <SettingsRow
          {...searchableSetting("boring-sidebar")}
          description="Group sidebar threads into project folders. Pinned and snoozed threads stay outside the folders."
          control={
            <Switch
              checked={settings.boringSidebarEnabled || settings.legacySidebarEnabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  boringSidebarEnabled: Boolean(checked),
                  legacySidebarEnabled: false,
                })
              }
              aria-label="Boring Sidebar (group by project)"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("working-shelf")}
          description="Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you. The boring sidebar has no Working section."
          control={
            <Switch
              checked={settings.sidebarWorkingShelfEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
              }
              aria-label="Working section"
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["idleCompaction", "compactIdleThreads"]}
          mixed={idleCompaction.mixed}
          {...searchableSetting("compact-idle-threads")}
          description="When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this."
          resetAction={
            globalIdleCompaction(settings) !== globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) ? (
              <SettingResetButton
                label="compact idle threads"
                onClick={() =>
                  updateSettings({ idleCompaction: globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) })
                }
              />
            ) : null
          }
          control={
            <Select
              value={idleCompaction.mixed ? null : globalIdleCompaction(settings)}
              onValueChange={(value) => {
                const mode = IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value);
                if (mode) updateSettings({ idleCompaction: mode.value });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Compact idle threads">
                <SelectValue>
                  {(value: string | null) =>
                    value === null
                      ? "Mixed"
                      : IDLE_COMPACTION_MODES.find((mode) => mode.value === value)?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {IDLE_COMPACTION_MODES.map((mode) => (
                  <SelectItem
                    hideIndicator
                    key={mode.value}
                    value={mode.value}
                    // A server from before modes has only the on/off switch, so it cannot store "Never".
                    disabled={mode.value === "off" && !idleCompaction.neverAvailable}
                  >
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["reviewGuidesEnabled"]}
          mixed={mixedReviewGuidesEnabled}
          {...searchableSetting("review-guides")}
          description="Adds a Guide tab to pull requests: an agent writes a tour of the change, stop by stop, with the calls a maintainer should make. Choose its model in Source Control."
          control={
            <Switch
              mixed={mixedReviewGuidesEnabled}
              checked={mixedReviewGuidesEnabled ? false : settings.reviewGuidesEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ reviewGuidesEnabled: Boolean(checked) })
              }
              aria-label="Review guides"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
