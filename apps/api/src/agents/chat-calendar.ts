import { z } from "zod";
import { timeZone } from "../interfaces/plan.ts";

export const chatCalendar = z.object({ date: z.iso.date(), timeZone });
export type ChatCalendar = z.infer<typeof chatCalendar>;

export function calendarFromMessage(message: string): ChatCalendar | undefined {
  const match = /^\[2do turn [a-f0-9-]{36}\]\n\[Planner date (\d{4}-\d{2}-\d{2}), ([^\]\n]+)\]\n/.exec(message);
  if (!match) return;
  return chatCalendar.safeParse({ date: match[1], timeZone: match[2] }).data;
}
