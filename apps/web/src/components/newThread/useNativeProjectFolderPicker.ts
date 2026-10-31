import { PRIMARY_LOCAL_ENVIRONMENT_ID, type EnvironmentId } from "@t3tools/contracts";

import {
  desktopLocalBackendId,
  isDesktopLocalConnectionTarget,
} from "../../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../../connection/useDesktopLocalBootstraps";
import { readLocalApi } from "../../localApi";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../../wslPaths";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * The OS folder dialog, for machines this desktop app runs itself. A folder
 * picked inside a WSL distro belongs to that distro's machine, so the result
 * names the machine as well as the path.
 */
export function useNativeProjectFolderPicker() {
  const { environments } = useEnvironments();
  const desktopLocalBootstraps = useDesktopLocalBootstraps();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  // The picker routes by the desktop's own pool id (e.g. "wsl:ubuntu"), not
  // the catalog environment id.
  const desktopInstanceIdFor = (environmentId: EnvironmentId): string | null => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    if (!environment || !isDesktopLocalConnectionTarget(environment.entry.target)) return null;
    if (environment.displayUrl === null) return null;
    return (
      desktopLocalBootstraps.find((bootstrap) => bootstrap.httpBaseUrl === environment.displayUrl)
        ?.id ?? null
    );
  };

  const canPick = (environmentId: EnvironmentId | null): boolean =>
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    environmentId !== null &&
    (environmentId === primaryEnvironmentId || desktopInstanceIdFor(environmentId) !== null);

  const pick = async (input: {
    readonly environmentId: EnvironmentId;
    readonly platform: string;
    readonly initialPath: string | undefined;
  }): Promise<{ readonly environmentId: EnvironmentId; readonly path: string } | null> => {
    const api = readLocalApi();
    if (!api || !canPick(input.environmentId)) return null;
    let desktopWslState =
      input.environmentId === primaryEnvironmentId && input.platform === "Linux"
        ? ((await window.desktopBridge?.getWslState().catch(() => null)) ?? null)
        : null;
    // A WSL-only primary has no secondary bootstrap, so its target comes from
    // the desktop settings; other primaries keep the native picker.
    const targetEnvironmentId = resolveProjectPickerTarget({
      browseEnvironmentId: input.environmentId,
      primaryEnvironmentId,
      desktopInstanceId: desktopInstanceIdFor(input.environmentId),
      wslConfiguration: desktopWslState,
    });
    const pickedPath = await api.dialogs
      .pickFolder({
        ...(input.initialPath ? { initialPath: input.initialPath } : {}),
        ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
      })
      .catch(() => null);
    if (!pickedPath) return null;
    if (!parseWslUncPath(pickedPath)) {
      return { environmentId: input.environmentId, path: pickedPath };
    }

    desktopWslState =
      desktopWslState ?? (await window.desktopBridge?.getWslState().catch(() => null)) ?? null;
    let primaryRunningDistro: string | null = null;
    try {
      primaryRunningDistro =
        window.desktopBridge
          ?.getLocalEnvironmentBootstraps()
          .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ??
        null;
    } catch {}
    const selection = resolveWslProjectSelection(
      pickedPath,
      applyWslEnvironmentConfiguration(
        environments.flatMap((environment) => {
          const backendId = desktopLocalBackendId(environment.entry.target);
          if (!backendId) return [];
          const bootstrap = desktopLocalBootstraps.find(
            (candidate) => candidate.httpBaseUrl === environment.displayUrl,
          );
          return [
            {
              environmentId: environment.environmentId,
              backendId,
              runningDistro: bootstrap?.runningDistro ?? null,
            },
          ];
        }),
        primaryEnvironmentId,
        desktopWslState,
        primaryRunningDistro,
      ),
    );
    if (!selection) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add WSL project",
          description: "Start the matching WSL backend, then choose the folder again.",
        }),
      );
      return null;
    }
    return { environmentId: selection.environmentId, path: selection.linuxPath };
  };

  return { canPick, pick };
}
