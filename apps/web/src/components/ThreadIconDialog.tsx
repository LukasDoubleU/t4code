import type { ProjectIconOverride } from "@t3tools/contracts";
import { lazy, Suspense, useEffect } from "react";
import { create } from "zustand";

// The picker lists every Lucide icon, so it loads only once a thread's icon is changed.
const ProjectIconPickerDialog = lazy(() =>
  import("./settings/ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

type Request = {
  readonly current: ProjectIconOverride | null;
  readonly threadTitle: string;
  readonly resolve: (icon: ProjectIconOverride | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks for a thread's own icon; null when the user cancels. */
export function requestThreadIcon(input: {
  readonly current: ProjectIconOverride | null;
  readonly threadTitle: string;
}): Promise<ProjectIconOverride | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...input, resolve } }));
}

function finish(icon: ProjectIconOverride | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(icon);
}

export function ThreadIconDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <ProjectIconPickerDialog
        current={request.current}
        projectName={request.threadTitle}
        title="Choose thread icon"
        open
        onOpenChange={(open) => {
          if (!open) finish(null);
        }}
        onSelect={(icon) => finish(icon)}
      />
    </Suspense>
  );
}
