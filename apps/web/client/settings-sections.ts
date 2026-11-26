import { Plug, CalendarDays, Keyboard, Palette, Puzzle, Target } from "lucide-react";

export const sections = [
  { id: "appearance", title: "Appearance", Icon: Palette },
  { id: "keybinds", title: "Keybinds", Icon: Keyboard },
  { id: "calendar", title: "Calendar", Icon: CalendarDays },
  { id: "connections", title: "Connections", Icon: Plug },
  { id: "plugins", title: "Plugins", Icon: Puzzle },
  { id: "goals", title: "Goals", Icon: Target },
] as const;
export type Section = (typeof sections)[number]["id"];
