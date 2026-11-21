import { ProviderInstanceId, type ProviderFallbackEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { moveEntry, withBudgetField } from "./ProviderFallbackSettings.logic";

const entry: ProviderFallbackEntry = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "openrouter/anthropic/claude-sonnet-4.5",
};

describe("withBudgetField", () => {
  it("starts a budget from either amount and keeps the run within the month", () => {
    expect(withBudgetField(entry, "perRunUsd", "2")?.budget).toEqual({
      monthlyUsd: 2,
      perRunUsd: 2,
    });
    const monthly = withBudgetField(entry, "monthlyUsd", "$10")!;
    expect(monthly.budget).toEqual({ monthlyUsd: 10, perRunUsd: 10 });
    expect(withBudgetField(monthly, "perRunUsd", "25")?.budget).toEqual({
      monthlyUsd: 10,
      perRunUsd: 10,
    });
    expect(withBudgetField(monthly, "group", " gemini-key ")?.budget?.group).toBe("gemini-key");
  });

  it("removes the budget with its monthly amount and refuses text that is no amount", () => {
    const budgeted = { ...entry, budget: { monthlyUsd: 10, perRunUsd: 1 } };
    expect(withBudgetField(budgeted, "monthlyUsd", "")).toEqual(entry);
    expect(withBudgetField(budgeted, "perRunUsd", "-1")).toBeNull();
    expect(withBudgetField(entry, "group", "shared")).toBeNull();
  });
});

describe("moveEntry", () => {
  it("swaps neighbours and leaves the ends in place", () => {
    const second = { ...entry, model: "openrouter/google/gemini-2.5-pro" };
    expect(moveEntry([entry, second], 1, -1)).toEqual([second, entry]);
    expect(moveEntry([entry, second], 1, 1)).toEqual([entry, second]);
  });
});
