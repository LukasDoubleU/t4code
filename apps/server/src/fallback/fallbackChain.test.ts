import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffMs,
  type ChainEntry,
  chainEntries,
  type EntryBlock,
  findChainEntry,
  firstReadyEntry,
  isChainTrigger,
  monthlyBudgetFor,
  monthOf,
  nextMonthStart,
  planChainMove,
  selectionFor,
} from "./fallbackChain.ts";

const chain = chainEntries([
  { instanceId: ProviderInstanceId.make("antigravity"), model: "gemini-3-pro" },
  {
    instanceId: ProviderInstanceId.make("antigravity_api"),
    model: "gemini-3-pro",
    budget: { monthlyUsd: 10, perRunUsd: 1 },
  },
  { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "openrouter/anthropic/claude-sonnet-4.5",
    budget: { monthlyUsd: 20, perRunUsd: 2 },
  },
]);
const [subscription, apiKey, codex, openRouter] = chain as [
  ChainEntry,
  ChainEntry,
  ChainEntry,
  ChainEntry,
];

const blocks =
  (blocked: Record<string, EntryBlock>) =>
  (entry: ChainEntry): EntryBlock | null =>
    blocked[entry.key] ?? null;
const never = () => null;

describe("planChainMove", () => {
  it("moves to the first entry that is ready, skipping every kind of block", () => {
    const plan = planChainMove({
      chain,
      from: subscription,
      block: blocks({
        [apiKey.key]: { kind: "budget", until: 50 },
        [codex.key]: { kind: "cooling", until: 20 },
      }),
      freesAt: never,
    });
    assert.equal(plan.type, "move");
    assert.equal(plan.type === "move" ? plan.to.key : null, openRouter.key);

    for (const block of [
      { kind: "tried" },
      { kind: "parked" },
      { kind: "unavailable" },
      { kind: "refused", reason: "no limit" },
    ] satisfies ReadonlyArray<EntryBlock>) {
      const skipped = planChainMove({
        chain,
        from: subscription,
        block: blocks({ [apiKey.key]: block }),
        freesAt: never,
      });
      assert.equal(skipped.type === "move" ? skipped.to.key : null, codex.key);
    }
  });

  it("never moves back to the entry that just stopped", () => {
    const plan = planChainMove({
      chain: [subscription],
      from: subscription,
      block: never,
      freesAt: never,
    });
    assert.equal(plan.type, "exhausted");
  });

  it("names the entry that frees up first when none is ready", () => {
    const blockedAll = blocks(
      Object.fromEntries(chain.map((entry) => [entry.key, { kind: "tried" } as EntryBlock])),
    );
    const plan = planChainMove({
      chain,
      from: codex,
      block: blockedAll,
      freesAt: (entry) =>
        entry.key === apiKey.key ? 300 : entry.key === subscription.key ? 200 : null,
    });
    assert.deepStrictEqual(plan, {
      type: "exhausted",
      from: codex,
      freesUp: { entry: subscription, at: 200 },
    });
  });
});

describe("chain entries", () => {
  it("puts a selection on the chain only with the instance and model an entry names", () => {
    assert.equal(
      findChainEntry(chain, { instanceId: codex.entry.instanceId, model: "gpt-5.4" }),
      codex,
    );
    // Another model on a chain instance is the user's own choice, off the chain.
    assert.isUndefined(
      findChainEntry(chain, { instanceId: codex.entry.instanceId, model: "gpt-5.4-mini" }),
    );
  });

  it("keeps the user's options only when a move stays on the same instance", () => {
    const options = [{ id: "effort", value: "high" }];
    assert.deepStrictEqual(
      selectionFor(codex.entry, { ...codex.entry, model: "gpt-5.4-mini", options }),
      { ...codex.entry, options },
    );
    assert.deepStrictEqual(selectionFor(apiKey.entry, { ...codex.entry, options }), {
      instanceId: apiKey.entry.instanceId,
      model: apiKey.entry.model,
    });
  });

  it("holds a budget group to the smallest monthly amount its entries set", () => {
    const grouped = chainEntries([
      { ...apiKey.entry, budget: { monthlyUsd: 10, perRunUsd: 1, group: "gemini" } },
      {
        instanceId: ProviderInstanceId.make("antigravity_flash"),
        model: "gemini-3-flash",
        budget: { monthlyUsd: 6, perRunUsd: 1, group: "gemini" },
      },
    ]);
    assert.equal(monthlyBudgetFor(grouped, grouped[0]!.entry), 6);
    assert.equal(monthlyBudgetFor(grouped, codex.entry), undefined);
  });

  it("gives a new turn back to an earlier entry once it is ready again", () => {
    const cooling = blocks({ [subscription.key]: { kind: "cooling", until: 100 } });
    assert.equal(firstReadyEntry(chain, cooling), apiKey);
    assert.equal(firstReadyEntry(chain, never), subscription);
  });
});

describe("chain triggers", () => {
  it("moves only on a failure an adapter marked with a structured quota signal", () => {
    assert.isTrue(
      isChainTrigger(makeProviderFailure({ class: "usage_limit", quota: "exhausted" })),
    );
    assert.isTrue(
      isChainTrigger(makeProviderFailure({ class: "provider_error", quota: "out_of_credit" })),
    );
    // A usage limit read from text, as Codex's managed errors are, stays on its entry.
    assert.isFalse(
      isChainTrigger(
        makeProviderFailure({
          class: "usage_limit",
          message: "subscription_sharing_usage_limit_exceeded",
        }),
      ),
    );
    assert.isFalse(isChainTrigger(null));
  });
});

describe("cool-down backoff and budget months", () => {
  it("doubles from ten minutes up to six hours", () => {
    assert.equal(backoffMs(1), BACKOFF_BASE_MS);
    assert.equal(backoffMs(2), 2 * BACKOFF_BASE_MS);
    assert.equal(backoffMs(30), BACKOFF_CAP_MS);
  });

  it("starts the next budget month on the first of the next UTC month", () => {
    const lastDayOfJanuary = Date.UTC(2027, 0, 31, 23, 30);
    assert.equal(nextMonthStart(lastDayOfJanuary), Date.UTC(2027, 1, 1));
    assert.equal(nextMonthStart(Date.UTC(2026, 11, 15)), Date.UTC(2027, 0, 1));
    assert.equal(monthOf(lastDayOfJanuary), "2027-01");
  });
});
