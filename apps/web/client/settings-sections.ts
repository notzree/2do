import { CalendarDays, Keyboard, Palette, Puzzle } from "lucide-react";

export const sections = [
  { id: "appearance", title: "Appearance", Icon: Palette },
  { id: "keybinds", title: "Keybinds", Icon: Keyboard },
  { id: "calendar", title: "Calendar", Icon: CalendarDays },
  { id: "plugins", title: "Plugins", Icon: Puzzle },
] as const;
export type Section = (typeof sections)[number]["id"];
