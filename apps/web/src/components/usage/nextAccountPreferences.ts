import {
  DEFAULT_MIN_SESSION_PERCENT,
  type NextAccountOptions,
  type WeeklyModelScope,
} from "@t3tools/shared/usageNextAccount";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-next-account:v1";
export const SESSION_ROOM_OPTIONS = [10, DEFAULT_MIN_SESSION_PERCENT, 50, 75] as const;
const NextAccountPreferences = Schema.Struct({
  minSessionPercent: Schema.Literals(SESSION_ROOM_OPTIONS),
  /** `any`, `other`, or `scope:<key>` for one model's own weekly allowance. */
  model: Schema.String,
  /** Start new threads on the recommended account. Preferences saved before it read as on. */
  startNewThreads: Schema.optionalKey(Schema.Boolean),
});
export type NextAccountPreferences = typeof NextAccountPreferences.Type;
const DEFAULT_PREFERENCES: NextAccountPreferences = {
  minSessionPercent: DEFAULT_MIN_SESSION_PERCENT,
  model: "any",
};

/** Per device. The Use next card and new drafts read the same choice. */
export function useNextAccountPreferences() {
  const [preferences, setPreferences] = useLocalStorage(
    STORAGE_KEY,
    DEFAULT_PREFERENCES,
    NextAccountPreferences,
  );
  const update = (patch: Partial<NextAccountPreferences>) =>
    setPreferences((current) => ({ ...current, ...patch }));
  return [preferences, update] as const;
}

// A remembered model whose allowance no account reports any more counts every allowance again.
export function rankedModel(
  choice: string,
  scopes: readonly WeeklyModelScope[],
): NextAccountOptions["model"] {
  if (choice === "other") return null;
  return scopes.find((scope) => `scope:${scope.key}` === choice)?.key;
}
