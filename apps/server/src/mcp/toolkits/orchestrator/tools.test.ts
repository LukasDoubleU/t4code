import { assert, expect, it } from "@effect/vitest";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});

it("sends agents to Settings → Connections for a machine that is not linked", () => {
  const namesLinkTool = /\bt3_environment_link\b/;
  assert.notProperty(OrchestratorToolkit.tools, "t3_environment_link");
  for (const tool of Object.values(OrchestratorToolkit.tools)) {
    assert.notMatch(tool.description ?? "", namesLinkTool, tool.name);
  }
  assert.notMatch(T3_CODE_ORCHESTRATION_INSTRUCTIONS, namesLinkTool);
  assert.include(
    OrchestratorToolkit.tools.t3_environment_links.description ?? "",
    "link it in Settings → Connections",
  );
  assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "link it in Settings → Connections");
});
