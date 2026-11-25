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

it("starts a fresh notebook in Graphite and respects an explicit System setting", () => {
  stored({});
  expect(readPreferences()).toMatchObject({ theme: "notebook", mode: "dark" });
  stored({ [storageKey]: JSON.stringify({ mode: "system" }) });
  expect(readPreferences().mode).toBe("system");
  stored({ [storageKey]: JSON.stringify({ theme: "nord" }) });
  expect(readPreferences()).toMatchObject({ theme: "nord", mode: "system" });
});

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

it("keeps legacy remaps and assigns unused keys to new date commands", () => {
  const old = { day: "d", week: "n", calendar: "m", today: "t", copilot: "a", settings: "s" };
  stored({ [storageKey]: JSON.stringify({ bindings: old }) });
  const { bindings } = readPreferences();
  expect(bindings).toMatchObject({ week: "n", calendar: "m", nextDay: "d" });
  expect(bindings).not.toHaveProperty("day");
  expect(new Set(Object.values(bindings)).size).toBe(Object.keys(defaultBindings).length);
});

it("rehydrates flat preferences, saves compatible JSON, and restores defaults after storage is cleared", async () => {
  const values = new Map([[storageKey, JSON.stringify({ theme: "nord", weekStart: 1 })]]);
  const setItem = vi.fn((key: string, value: string) => values.set(key, value));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem });
  const { usePreferences } = await import("./preference-store.ts");
  await usePreferences.persist.rehydrate();
  expect(usePreferences.getState()).toMatchObject({ theme: "nord", mode: "system", weekStart: 1 });
  usePreferences.setState({ mode: "light" });
  expect(JSON.parse(values.get(storageKey)!)).toEqual({ ...defaults, theme: "nord", mode: "light", weekStart: 1 });
  values.clear();
  await usePreferences.persist.rehydrate();
  expect(usePreferences.getState()).toEqual(defaults);
  expect(setItem).toHaveBeenCalledTimes(1);
});
