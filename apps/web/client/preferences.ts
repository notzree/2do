import { nextPeriods, previousPeriods, type WeekStart } from "./calendar.ts";

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
  { id: "week", name: "Open Week", key: "w" },
  { id: "calendar", name: "Open Month", key: "c" },
  { id: "nextDay", name: nextPeriods.nextDay, key: "d" },
  { id: "previousDay", name: previousPeriods.previousDay, key: "h" },
  { id: "nextWeek", name: nextPeriods.nextWeek, key: "n" },
  { id: "previousWeek", name: previousPeriods.previousWeek, key: "p" },
  { id: "nextMonth", name: nextPeriods.nextMonth, key: "m" },
  { id: "previousMonth", name: previousPeriods.previousMonth, key: "b" },
  { id: "today", name: "Go to today", key: "t" },
  { id: "agents", name: "Open Agents workspace", key: "a" },
  { id: "copilot", name: "Open quick chat", key: "q" },
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
  mode: "dark",
  weekStart: 0,
  keysEnabled: true,
  bindings: defaultBindings,
};
export const storageKey = "2do.preferences.v1";

function restoreBindings(stored: Partial<Bindings> | undefined): Bindings {
  // Before Agents had its own binding, saved defaults included copilot: "a".
  if (stored?.agents === undefined && stored?.copilot === "a") {
    stored = { ...stored };
    delete stored.copilot;
  }
  const result = { ...defaultBindings };
  const used = new Set<string>();
  for (const { id } of commands) {
    const key = stored?.[id];
    if (key === undefined) continue;
    if (!availableKeys.includes(key) || used.has(key)) return defaultBindings;
    result[id] = key;
    used.add(key);
  }
  // Preserve remaps from older versions, even when they use a new command's default.
  for (const { id, key } of commands) {
    if (stored?.[id] !== undefined) continue;
    result[id] = used.has(key)
      ? availableKeys.find((k) => !used.has(k) && !boundCommand(defaultBindings, k))!
      : key;
    used.add(result[id]);
  }
  return result;
}

export function readPreferences(): Preferences {
  try {
    const stored = localStorage.getItem(storageKey);
    const value = stored ? JSON.parse(stored) : {};
    const mode = value?.mode ?? localStorage.getItem("planner-theme");
    const selectedTheme = themes.find((t) => t.id === value?.theme);
    return {
      theme: selectedTheme?.id ?? defaults.theme,
      mode: mode === "system" || mode === "light" || mode === "dark"
        ? mode : selectedTheme ? "system" : defaults.mode,
      weekStart: value?.weekStart === 1 ? 1 : 0,
      keysEnabled:
        typeof value?.keysEnabled === "boolean"
          ? value.keysEnabled
          : localStorage.getItem("planner-keys") !== "off",
      bindings: restoreBindings(value?.bindings),
    };
  } catch {
    return defaults;
  }
}
