import { Temporal } from "@js-temporal/polyfill";
import type { Task } from "../interfaces/plan.ts";

export function scheduleDay(schedule: Task["schedule"], zone: string) {
  if (!schedule) return undefined;
  if (schedule.type === "day") return schedule.date;
  return Temporal.Instant.from(schedule.start).toZonedDateTimeISO(zone).toPlainDate().toString();
}

export function shiftSchedule(
  schedule: Task["schedule"],
  date: string,
  zone: string,
): Task["schedule"] {
  if (!schedule) return { type: "day", date };
  const days = Temporal.PlainDate.from(scheduleDay(schedule, zone)!).until(date).days;
  if (schedule.type === "day")
    return {
      ...schedule,
      date,
      ...(schedule.endDateExclusive && {
        endDateExclusive: Temporal.PlainDate.from(schedule.endDateExclusive)
          .add({ days })
          .toString(),
      }),
    };
  const start = Temporal.Instant.from(schedule.start)
    .toZonedDateTimeISO(zone)
    .add({ days })
    .toInstant();
  const duration = Temporal.Instant.from(schedule.start).until(Temporal.Instant.from(schedule.end));
  return { type: schedule.type, start: start.toString(), end: start.add(duration).toString() };
}
