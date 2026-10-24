import { describe, expect, it } from "vite-plus/test";

import { formatAppDisplayName } from "./branding.logic";

describe("formatAppDisplayName", () => {
  it("shows release builds without a stage label", () => {
    expect(formatAppDisplayName({ baseName: "T4 Code", stageLabel: "Beta" })).toBe("T4 Code");
    expect(formatAppDisplayName({ baseName: "T4 Code", stageLabel: "Dev" })).toBe("T4 Code (Dev)");
  });
});
