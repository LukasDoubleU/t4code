import { describe, expect, it } from "vite-plus/test";
import { CATPPUCCIN_THEME } from "@t3tools/shared/themePalettes";

import {
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeModes,
  themeColorToHex,
  type ThemeColorRole,
  type ThemeColors,
} from "./themePalette";

function hex(value: string): string {
  const color = themeColorToHex(value);
  if (!color) throw new Error(`Expected a theme color, received ${value}`);
  return color;
}

function contrastRatio(first: string, second: string): number {
  const luminance = (value: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((index) => Number.parseInt(hex(value).slice(index, index + 2), 16) / 255)
      .map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

const MOCHA = getThemeColorsForMode(CATPPUCCIN_THEME, "dark")!;
const LATTE = getThemeColorsForMode(CATPPUCCIN_THEME, "light")!;

// Text on accent-colored surfaces (primary buttons, default badges, the send
// button), on selected, active, and hovered rows, on status surfaces, and on
// the panes and controls around them.
const TEXT_PAIRS: ReadonlyArray<readonly [ThemeColorRole, ThemeColorRole]> = [
  ["accentForeground", "accent"],
  ["messageActionForeground", "messageAction"],
  ["messageActionForeground", "messageActionHover"],
  ["sidebarForeground", "sidebarRowActive"],
  ["sidebarMutedForeground", "sidebarRowActive"],
  ["sidebarForeground", "sidebarRowSelected"],
  ["sidebarMutedForeground", "sidebarRowSelected"],
  ["sidebarForeground", "sidebarRowHover"],
  ["sidebarMutedForeground", "sidebarRowHover"],
  ["sidebarForeground", "sidebarControlSurface"],
  ["sidebarForeground", "sidebar"],
  ["sidebarMutedForeground", "sidebar"],
  ["accentSurfaceForeground", "accentSurface"],
  ["mutedForeground", "accentSurface"],
  ["errorForeground", "errorSurface"],
  ["warningForeground", "warningSurface"],
  ["updateForeground", "updateSurface"],
  // Clerk's sign-in card sets status and primary text straight on the surface.
  ["errorForeground", "surface"],
  ["warningForeground", "surface"],
  ["updateForeground", "surface"],
  ["searchMatchForeground", "searchMatchBackground"],
  ["searchMatchActiveForeground", "searchMatchActiveBackground"],
  ["textMuted", "canvas"],
  ["text", "surfaceOverlay"],
  ["mutedForeground", "surfaceOverlay"],
  ["placeholder", "surfaceRaised"],
  ["toolbarControlForeground", "toolbarControl"],
  ["toolbarControlForeground", "toolbarControlHover"],
  ["secondaryForeground", "secondary"],
  ["mutedForeground", "muted"],
  ["messageForeground", "messageSurface"],
  ["codeForeground", "codeBackground"],
  ["terminalForeground", "terminalBackground"],
  ["terminalForeground", "terminalSelection"],
];

function expectOfficialColors(
  colors: ThemeColors,
  expected: Readonly<Partial<Record<ThemeColorRole, string>>>,
): void {
  for (const [role, value] of Object.entries(expected)) {
    expect(hex(colors[role as ThemeColorRole]), role).toBe(value);
  }
}

describe("Catppuccin theme", () => {
  it("is a built-in with Mocha first and Latte for light mode", () => {
    expect(getThemeDefinition(CATPPUCCIN_THEME.id)).toBe(CATPPUCCIN_THEME);
    expect(CATPPUCCIN_THEME.appearance).toBe("dark");
    expect(getThemeModes(CATPPUCCIN_THEME)).toEqual(["light", "dark"]);
  });

  it("puts the official Mocha colors on the roles they name", () => {
    expectOfficialColors(MOCHA, {
      canvas: "#1e1e2e",
      surfaceRaised: "#313244",
      surfaceOverlay: "#181825",
      sidebar: "#181825",
      sidebarRowActive: "#313244",
      text: "#cdd6f4",
      textMuted: "#a6adc8",
      border: "#313244",
      accent: "#f5e0dc",
      accentForeground: "#1e1e2e",
      messageAction: "#f5e0dc",
      messageActionForeground: "#1e1e2e",
      messageActionHover: "#f2cdcd",
      focus: "#f5e0dc",
      error: "#f38ba8",
      warning: "#f9e2af",
      update: "#89b4fa",
      codeBackground: "#181825",
      terminalBackground: "#1e1e2e",
      terminalForeground: "#cdd6f4",
      terminalCursor: "#f5e0dc",
    });
  });

  it("puts the official Latte colors on the roles they name", () => {
    expectOfficialColors(LATTE, {
      canvas: "#eff1f5",
      surfaceRaised: "#e6e9ef",
      sidebar: "#dce0e8",
      sidebarRowActive: "#eff1f5",
      text: "#4c4f69",
      textMuted: "#5c5f77",
      border: "#ccd0da",
      accent: "#dc8a78",
      // Latte's own Base is unreadable on its Rosewater; Mocha's Base is not.
      accentForeground: "#1e1e2e",
      messageAction: "#dc8a78",
      messageActionForeground: "#1e1e2e",
      messageActionHover: "#dd7878",
      error: "#d20f39",
      warning: "#df8e1d",
      update: "#1e66f5",
      codeBackground: "#dce0e8",
      terminalBackground: "#eff1f5",
      terminalForeground: "#4c4f69",
      terminalCursor: "#dc8a78",
    });
  });

  it.each([
    ["Mocha", MOCHA],
    ["Latte", LATTE],
  ] as const)("keeps %s text readable on its surfaces (WCAG AA)", (_flavor, colors) => {
    expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(7);
    for (const [foreground, background] of TEXT_PAIRS) {
      expect(
        contrastRatio(colors[foreground], colors[background]),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const pane of ["canvas", "surfaceRaised", "sidebar"] as const) {
      expect(contrastRatio(colors.focus, colors[pane]), `focus on ${pane}`).toBeGreaterThanOrEqual(
        3,
      );
    }
  });
});
