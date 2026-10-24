import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_THEME_ID } from "@t3tools/shared/themePalettes";

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("default theme", () => {
  it("opens a client that never chose a theme on the default theme, following the OS", async () => {
    const storage = createStorage();
    vi.stubGlobal("window", { localStorage: storage });

    const { readAppearanceModePreference, readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe(DEFAULT_THEME_ID);
    expect(readAppearanceModePreference(DEFAULT_THEME_ID)).toBe("system");
    storage.setItem("t3code:theme-appearance-mode", "dark");
    expect(readAppearanceModePreference(DEFAULT_THEME_ID)).toBe("dark");
  });

  it("keeps a chosen theme, including the standard one, and an unknown id stays standard", async () => {
    const storage = createStorage();
    vi.stubGlobal("window", { localStorage: storage });

    const { readThemePreference } = await import("./useTheme");

    for (const theme of ["system", "light", "dark", "grove"]) {
      storage.setItem("t3code:theme", theme);
      expect(readThemePreference()).toBe(theme);
    }
    storage.setItem("t3code:theme", "gone-theme");
    expect(readThemePreference()).toBe("system");
  });
});
