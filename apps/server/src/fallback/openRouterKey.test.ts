import { assert, describe, it } from "@effect/vitest";

import { isOpenRouterEntry, NO_LIMIT, readKeyCheck } from "./openRouterKey.ts";

describe("readKeyCheck", () => {
  it("accepts a key with a credit limit", () => {
    assert.deepStrictEqual(
      readKeyCheck(200, { data: { label: "sk-or-v1-abc...", limit: 25, limit_remaining: 19.5 } }),
      { ok: true, limitUsd: 25, remainingUsd: 19.5 },
    );
  });

  it("refuses a key without a limit, for good", () => {
    assert.deepStrictEqual(readKeyCheck(200, { data: { limit: null, usage: 3 } }), {
      ok: false,
      reason: NO_LIMIT,
      retry: false,
    });
    assert.deepStrictEqual(readKeyCheck(200, { data: { usage: 3 } }), {
      ok: false,
      reason: NO_LIMIT,
      retry: false,
    });
  });

  it("refuses a rejected key and retries a check that could not answer", () => {
    assert.deepStrictEqual(readKeyCheck(401, { error: { message: "No auth credentials found" } }), {
      ok: false,
      reason: "OpenRouter rejected this entry's key.",
      retry: false,
    });
    const outage = readKeyCheck(503, null);
    assert.isFalse(outage.ok);
    assert.isTrue(!outage.ok && outage.retry);
  });
});

describe("isOpenRouterEntry", () => {
  it("names OpenCode and Pi entries whose model OpenRouter serves", () => {
    assert.isTrue(isOpenRouterEntry("opencode", "openrouter/anthropic/claude-sonnet-4.5"));
    assert.isTrue(isOpenRouterEntry("pi", "openrouter/google/gemini-2.5-pro"));
    assert.isFalse(isOpenRouterEntry("opencode", "anthropic/claude-sonnet-4.5"));
    assert.isFalse(isOpenRouterEntry("codex", "openrouter/x"));
  });
});
