import type { WeekStart } from "./calendar.ts";

export const themes = [
  { id: "notebook", name: "Notebook", light: "Paper", dark: "Graphite" },
  { id: "catppuccin", name: "Catppuccin", light: "Latte", dark: "Mocha" },
  { id: "nord", name: "Nord", light: "Snow Storm", dark: "Polar Night" },
  { id: "gruvbox", name: "Gruvbox", light: "Light", dark: "Dark" },
  { id: "solarized", name: "Solarized", light: "Light", dark: "Dark" },
  { id: "tokyo-night", name: "Tokyo Night", light: "Day", dark: "Night" },
] as const;

export type Theme = (typeof themes)[number]["id"];
export type Mode = "light" | "dark" | "system";

export const commands = [
  { id: "day", name: "Open Daybook", key: "d" },
  { id: "week", name: "Open Week", key: "w" },
  { id: "calendar", name: "Open Calendar", key: "c" },
  { id: "today", name: "Go to today", key: "t" },
  { id: "copilot", name: "Open Copilot", key: "a" },
  { id: "settings", name: "Open Settings", key: "s" },
] as const;
export type Command = (typeof commands)[number]["id"];
export type Bindings = Record<Command, string>;
export const defaultBindings = Object.fromEntries(commands.map((c) => [c.id, c.key])) as Bindings;
// "g g" is the existing Vim motion for the first block or task.
export const availableKeys = [..."abcdefhijklmnopqrstuvwxyz0123456789"];
export function boundCommand(bindings: Bindings, key: string) {
  return commands.find((c) => bindings[c.id] === key)?.id;
}
export type Preferences = {
  theme: Theme;
  mode: Mode;
  weekStart: WeekStart;
  keysEnabled: boolean;
  bindings: Bindings;
};
export const defaults: Preferences = {
  theme: "notebook",
  mode: "system",
  weekStart: 0,
  keysEnabled: true,
  bindings: defaultBindings,
};
export const storageKey = "2do.preferences.v1";

export function readPreferences(): Preferences {
  try {
    const stored = localStorage.getItem(storageKey);
    const value = stored ? JSON.parse(stored) : {};
    const mode = value?.mode ?? localStorage.getItem("planner-theme");
    const bindings = value?.bindings;
    const keys = commands.map((c) => bindings?.[c.id]);
    return {
      theme: themes.find((t) => t.id === value?.theme)?.id ?? defaults.theme,
      mode: mode === "light" || mode === "dark" ? mode : "system",
      weekStart: value?.weekStart === 1 ? 1 : 0,
      keysEnabled:
        typeof value?.keysEnabled === "boolean"
          ? value.keysEnabled
          : localStorage.getItem("planner-keys") !== "off",
      bindings:
        keys.every((k) => availableKeys.includes(k)) && new Set(keys).size === keys.length
          ? bindings
          : defaultBindings,
    };
  } catch {
    return defaults;
  }
}
