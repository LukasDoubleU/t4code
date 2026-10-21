import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { connectionAtomRuntime } from "./connection/runtime";
import { useOpenInPreferredEditor } from "./editorPreferences";
import { useCopyToClipboard } from "./hooks/useCopyToClipboard";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "./state/environments";
import { primaryServerAvailableEditorsAtom, serverEnvironment } from "./state/server";
import { activeThreadMemoryDirectory, activeThreadMemoryPath } from "./threadMemory.logic";

const threadMemoryDirectoryAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    activeThreadMemoryDirectory(get(serverEnvironment.configValueAtom(environmentId))),
  ).pipe(Atom.withLabel(`thread-memory:directory:${environmentId}`)),
);

/** Read while a memory tooltip is open; nothing polls the file. */
export const threadMemoryMetadata = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "thread-memory:metadata",
  tag: WS_METHODS.filesystemGetMetadata,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export function useThreadMemoryPath(threadRef: ScopedThreadRef, pinned: boolean): string | null {
  const directory = useAtomValue(threadMemoryDirectoryAtom(threadRef.environmentId));
  return activeThreadMemoryPath({ directory, pinned, threadId: threadRef.threadId });
}

export function readThreadMemoryPath(threadRef: ScopedThreadRef, pinned: boolean): string | null {
  const directory = appAtomRegistry.get(threadMemoryDirectoryAtom(threadRef.environmentId));
  return activeThreadMemoryPath({ directory, pinned, threadId: threadRef.threadId });
}

/**
 * Opens the file in the preferred editor when the thread runs on this machine.
 * An editor on another machine is no use here, so a remote thread's path is
 * copied and shown instead.
 */
export function useOpenThreadMemory() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const openInPreferredEditor = useOpenInPreferredEditor(primaryEnvironmentId, availableEditors);
  const { copyToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Memory path copied", description: path });
    },
    onError: (_error, { path }) => {
      toastManager.add({ type: "info", title: "Memory file", description: path });
    },
  });
  return async (threadRef: ScopedThreadRef, path: string) => {
    if (threadRef.environmentId !== primaryEnvironmentId) {
      copyToClipboard(path, { path });
      return;
    }
    const result = await openInPreferredEditor(path);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open memory",
          description: error instanceof Error ? error.message : path,
        }),
      );
    }
  };
}
