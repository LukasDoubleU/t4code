import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/** `add` lists the ways to add a project above the existing projects. */
export interface NewThreadDialogRequest {
  readonly intent: "new-thread" | "add-project";
}

interface NewThreadDialogState {
  readonly request: NewThreadDialogRequest | null;
  /** Per device: each client has its own idea of which machine it mostly works on. */
  readonly lastEnvironmentId: EnvironmentId | null;
}

export const useNewThreadDialogStore = create<NewThreadDialogState>()(
  persist((): NewThreadDialogState => ({ request: null, lastEnvironmentId: null }), {
    name: "t3code:new-thread-dialog:v1",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    partialize: (state) => ({ lastEnvironmentId: state.lastEnvironmentId }),
  }),
);

/** Opens the dialog that starts a thread: machine, then project, folder, or clone. */
export function openNewThreadDialog(request: NewThreadDialogRequest = { intent: "new-thread" }) {
  useNewThreadDialogStore.setState({ request });
}

export function closeNewThreadDialog() {
  useNewThreadDialogStore.setState({ request: null });
}

export function rememberNewThreadMachine(environmentId: EnvironmentId) {
  useNewThreadDialogStore.setState({ lastEnvironmentId: environmentId });
}
