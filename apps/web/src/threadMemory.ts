import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { connectionAtomRuntime } from "./connection/runtime";
import { useOpenInPreferredEditor } from "./editorPreferences";
import { useCopyToClipboard } from "./hooks/useCopyToClipboard";
import { readLocalApi } from "./localApi";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { waitForThreadShell } from "./state/entities";
import { usePrimaryEnvironmentId } from "./state/environments";
import {
  environmentServerConfigsAtom,
  primaryServerAvailableEditorsAtom,
  serverEnvironment,
} from "./state/server";
import { threadEnvironment } from "./state/threads";
import { useOrchestrationCommand } from "./state/use-orchestration-command";
import { activeThreadMemoryDirectory, activeThreadMemoryPath } from "./threadMemory.logic";
import { buildThreadRouteParams } from "./threadRoutes";

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

export function readEnvironmentSupportsFreshStart(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadFreshStart === true
  );
}

/** Opens the other end of a fresh start: the thread it continued in, or the one it continues. */
export function useOpenLinkedThread() {
  const router = useRouter();
  return (environmentId: EnvironmentId, threadId: ThreadId) =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
}

/**
 * Continues a pinned thread in a new one that takes over its pin and memory,
 * then opens the new thread.
 */
export function useFreshStartThread() {
  const freshStart = useOrchestrationCommand(threadEnvironment.freshStart, {
    reportFailure: false,
  });
  const openLinkedThread = useOpenLinkedThread();
  return async (threadRef: ScopedThreadRef) => {
    const confirmed = await readLocalApi()?.dialogs.confirm(
      [
        "Start this thread fresh?",
        "A new pinned thread takes its place and its memory, and this one is settled.",
      ].join("\n"),
    );
    if (confirmed !== true) return;
    const result = await freshStart({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start fresh",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    const continuation = scopeThreadRef(threadRef.environmentId, result.value.newThreadId);
    if (await waitForThreadShell(continuation)) {
      await openLinkedThread(continuation.environmentId, continuation.threadId);
    }
  };
}
