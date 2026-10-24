import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { threadContextRecord } from "../lib/composerContextRecords";
import { readThreadShell } from "../state/entities";
import { useNewThreadHandler } from "./useHandleNewThread";

/**
 * Opens a new-thread draft in an expert's project, filed as the expert's topic once sent. The
 * draft starts with a link to the expert, so the topic's agent can read the expert's context;
 * the expert itself hears nothing.
 */
export function useStartThreadTopic() {
  const handleNewThread = useNewThreadHandler();
  return async (expert: ScopedThreadRef) => {
    const shell = readThreadShell(expert);
    if (!shell) return null;
    const opened = await handleNewThread(scopeProjectRef(expert.environmentId, shell.projectId), {
      topicOf: expert,
    });
    if (!opened) return null;
    useComposerDraftStore
      .getState()
      .addThreadContexts(opened.draftId, [threadContextRecord(expert, shell.title)], {
        insertAtCaret: false,
      });
    return opened;
  };
}
