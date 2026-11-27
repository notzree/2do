import * as v from "valibot";

export const navigationCommands = [
  "week",
  "calendar",
  "nextDay",
  "previousDay",
  "nextWeek",
  "previousWeek",
  "nextMonth",
  "previousMonth",
  "today",
  "settings",
  "agents",
  "copilot",
] as const;
export const workspaceAction = v.object({
  command: v.picklist([
    ...navigationCommands,
    "inbox",
    "newChat",
    "switchChat",
    "inspectTask",
    "graph",
    "appearance",
    "openConnection",
    "commands",
    "capture",
    "gmailSuggestions",
    "editSelection",
    "undoDraft",
    "redoDraft",
  ]),
  itemId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(300))),
  inboxAction: v.optional(v.picklist(["read", "unread", "archive", "undoTime"])),
  taskId: v.optional(v.pipe(v.string(), v.uuid())),
  chatId: v.optional(v.union([v.literal("me"), v.pipe(v.string(), v.uuid())])),
  date: v.optional(v.pipe(v.string(), v.isoDate())),
  section: v.optional(
    v.picklist(["appearance", "keybinds", "calendar", "connections", "plugins", "goals", "agent"]),
  ),
  mode: v.optional(v.picklist(["light", "dark", "system"])),
  theme: v.optional(
    v.picklist(["notebook", "catppuccin", "nord", "gruvbox", "solarized", "tokyo-night"]),
  ),
  weekStart: v.optional(v.picklist([0, 1])),
  keysEnabled: v.optional(v.boolean()),
  binding: v.optional(
    v.object({
      command: v.picklist(navigationCommands),
      key: v.pipe(v.string(), v.regex(/^[a-fh-z0-9]$/)),
    }),
  ),
  resetBindings: v.optional(v.boolean()),
  edit: v.optional(v.picklist(["replace", "bold", "italic", "underline"])),
  text: v.optional(v.pipe(v.string(), v.maxLength(2000))),
});
export type WorkspaceAction = v.InferOutput<typeof workspaceAction>;
