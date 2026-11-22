import type { LocalThreadErrorEntry } from "../ChatView.logic";

const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

/** The error above the timeline: the view's own error, else the server's last error. */
export function resolveThreadErrorBanner(input: {
  readonly threadKey: string;
  readonly localError: LocalThreadErrorEntry | undefined;
  readonly serverError: string | null;
  /** The run the server's error came from, so a later run's same error shows again. */
  readonly serverErrorSource?: string | null;
}) {
  const localError = input.localError?.message ?? null;
  const error = localError ?? input.serverError;
  if (error === null) return { error, bannerKey: null, visible: false };
  // Each failed action raises its own local error, so dismissing one never hides the next.
  const bannerKey =
    localError === null
      ? `${input.threadKey}\u0000${input.serverErrorSource ?? ""}\u0000${error}`
      : `${input.threadKey}\u0000${error}\u0000${input.localError?.at}`;
  return { error, bannerKey, visible: !sessionDismissedThreadErrorBannerKeys.has(bannerKey) };
}
