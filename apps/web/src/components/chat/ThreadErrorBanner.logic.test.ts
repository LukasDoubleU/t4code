import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  resolveThreadErrorBanner,
} from "./ThreadErrorBanner.logic";

const REFUSAL =
  "The previous provider is still running background agents or commands, and switching would end them. Wait for them to finish, or press Stop, then send the message again.";

describe("resolveThreadErrorBanner", () => {
  it("shows a refused send again after an earlier identical refusal was dismissed", () => {
    const first = resolveThreadErrorBanner({
      threadKey: "env:thread-a",
      localError: { message: REFUSAL, at: 1 },
      serverError: null,
    });
    dismissThreadErrorBannerForSession(first.bannerKey);

    expect(
      resolveThreadErrorBanner({
        threadKey: "env:thread-a",
        localError: { message: REFUSAL, at: 2 },
        serverError: null,
      }),
    ).toMatchObject({ error: REFUSAL, visible: true });
  });

  it("keeps a dismissed server error hidden while it stays the thread's last error", () => {
    const serverError = JSON.stringify({ error: { message: "Turn failed", code: "first" } });
    const dismissed = resolveThreadErrorBanner({
      threadKey: "env:thread-b",
      localError: undefined,
      serverError,
    });
    dismissThreadErrorBannerForSession(dismissed.bannerKey);

    expect(
      resolveThreadErrorBanner({ threadKey: "env:thread-b", localError: undefined, serverError }),
    ).toMatchObject({ error: serverError, visible: false });
    expect(
      resolveThreadErrorBanner({
        threadKey: "env:thread-b",
        localError: undefined,
        serverError: JSON.stringify({ error: { message: "Turn failed", code: "second" } }),
      }).visible,
    ).toBe(true);
  });
});
