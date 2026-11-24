import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  boundCommand,
  defaultBindings,
  defaults,
  readPreferences,
  storageKey,
} from "./preferences.ts";

function stored(values: Record<string, string>) {
  vi.stubGlobal("localStorage", { getItem: (key: string) => values[key] ?? null });
}
afterEach(() => vi.unstubAllGlobals());

it("carries the previous color mode and Vim preference into settings", () => {
  stored({ "planner-theme": "dark", "planner-keys": "off" });
  expect(readPreferences()).toEqual({ ...defaults, mode: "dark", keysEnabled: false });
});

it("restores the chosen theme, week start, and remapped navigation", () => {
  const prefs = {
    ...defaults,
    theme: "catppuccin",
    mode: "dark",
    weekStart: 1,
    bindings: { ...defaultBindings, week: "z" },
  };
  stored({ [storageKey]: JSON.stringify(prefs) });
  const saved = readPreferences();
  expect(saved).toEqual(prefs);
  expect(boundCommand(saved.bindings, "z")).toBe("week");
  expect(boundCommand(saved.bindings, "w")).toBeUndefined();
});

it("rejects conflicting and reserved shortcuts without discarding valid settings", () => {
  for (const week of ["g", "d"]) {
    stored({
      [storageKey]: JSON.stringify({
        ...defaults,
        theme: "nord",
        bindings: { ...defaultBindings, week },
      }),
    });
    expect(readPreferences()).toEqual({ ...defaults, theme: "nord" });
  }
});
