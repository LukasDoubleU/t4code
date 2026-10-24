import { assert, it } from "@effect/vitest";

import { T3_CODE_ORCHESTRATION_SECTIONS } from "./orchestrationInstructions.ts";

it("keeps every section whole within Codex's per-entry limit", () => {
  for (const section of T3_CODE_ORCHESTRATION_SECTIONS) {
    assert.isBelow(new TextEncoder().encode(section).length, 4000);
  }
});
