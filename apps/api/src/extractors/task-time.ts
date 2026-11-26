import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import type { Task } from "../interfaces/plan.ts";
import type { ExtractionField, TitleExtractor } from "./clairic.ts";

export type TaskTiming = Partial<Pick<Task, "schedule" | "durationMinutes" | "due">>;

type TimingContext = {
  timeZone: string;
  referenceDate?: string;
  defaultDate?: string;
  durationMinutes?: number | null;
  deadline?: boolean;
};

const date = z.iso.date();
const time = z.iso.time();
const duration = z.int().positive().max(525600);
const standardOffsets = new Map([
  ["EST", "-05:00"],
  ["EDT", "-04:00"],
  ["CST", "-06:00"],
  ["CDT", "-05:00"],
  ["MST", "-07:00"],
  ["MDT", "-06:00"],
  ["PST", "-08:00"],
  ["PDT", "-07:00"],
]);

function timingFields(deadline: boolean): ExtractionField[] {
  const relative =
    "Use the calendar reference to resolve relative days in the title. Read only the title for intent.";
  const due = deadline
    ? "The title was entered as a deadline. Treat an otherwise unqualified date or time as its due date or time."
    : "A deadline must be stated or clearly conveyed as a due time, distinct from planned work.";
  const fields: ExtractionField[] = [
    {
      path: "scheduled_date",
      kind: "date",
      instructions:
        "Date when the planned work occurs. Return null for a title with no day or a date that is only a deadline. " +
        relative +
        " " +
        due,
    },
    {
      path: "scheduled_date_phrase",
      kind: "text",
      instructions:
        "Copy the exact calendar date expression for when the work happens, such as 'tomorrow', 'Thursday', or 'Dec 4'. Return null if the title contains only a clock time, a duration, or a date that is only a deadline. " +
        due,
    },
    {
      path: "start_time",
      kind: "time",
      instructions:
        "Starting clock time of a scheduled appointment or work block, read only from the title. E.g. at 7 am -> 07:00:00. No deadline time, no ambiguous or alternative times. " +
        due,
    },
    {
      path: "end_time",
      kind: "time",
      instructions:
        "Ending clock time of a scheduled work block or appointment. In '2–3pm', the end is 15:00:00. Ignore any deadlines. Use only a stated clock time, not a computed end from a duration. " +
        due,
    },
    {
      path: "end_time_phrase",
      kind: "text",
      instructions:
        "Copy the exact ending clock time of the scheduled work interval from the task title, such as '3pm' in '2–3pm'. Return null if only a duration or a deadline is given.",
    },
    {
      path: "scheduled_time_zone",
      kind: "text",
      instructions:
        "Copy the time zone or UTC offset written next to the scheduled clock time, for example 'PST', 'UTC', '+02:00', or 'America/Toronto'. Return null if the title does not state one for the schedule.",
    },
    {
      path: "ambiguous_schedule",
      kind: "boolean",
      instructions:
        "Does the title give alternative scheduled times without choosing one, or give a start hour whose AM/PM is unclear? For example, return true for '7pm or 9pm' or 'at 7'. A definite range such as '2–3pm' is not ambiguous.",
    },
    {
      path: "due_date",
      kind: "date",
      instructions:
        "The calendar date by which the task is due. Return null if no deadline date is stated. " +
        relative +
        " " +
        due,
    },
    {
      path: "deadline_phrase",
      kind: "text",
      instructions:
        "Copy the clause in the task title that says when it must be finished, for example 'due Friday' or 'by the end of the month'. Return null for ordinary scheduled times, including 'at 7am' or 'meet Friday'. Include the wording that makes it a deadline.",
    },
    {
      path: "due_time",
      kind: "time",
      instructions:
        "Local time after the due date, in HH:mm:ss. Ignore times before the deadline phrase. " +
        due,
    },
    {
      path: "due_time_phrase",
      kind: "text",
      instructions:
        "Exact clock-time phrase belonging to a deadline in the task title. Copy just the phrase including AM or PM, for example '5pm'. No phrase for end of day without a clock time. " +
        due,
    },
    {
      path: "due_time_zone",
      kind: "text",
      instructions:
        "Copy the time zone or UTC offset explicitly attached to the due time, such as 'PST', 'UTC', or '+02:00'. Ignore the time zone of any separate work block.",
    },
    {
      path: "duration_seconds",
      kind: "duration",
      instructions:
        "Only explicitly stated amount of time spent doing the task, in seconds. Null when absent. Distances including meters abbreviated m are not elapsed time.",
    },
  ];
  return fields.map((field) => ({ ...field, modelKey: field.path }));
}

function calendarReference(reference: Temporal.PlainDate) {
  const days = Array.from({ length: 7 }, (_, offset) => {
    const day = reference.add({ days: offset });
    const weekday = day.toLocaleString("en-US", { weekday: "long" });
    if (offset === 0) return weekday + " " + day.toString() + " is today";
    if (offset === 1) return "tomorrow is " + weekday + " " + day.toString();
    return weekday + " is " + day.toString();
  });
  return (
    "Calendar reference: " +
    days.join("; ") +
    ". This month's last day is " +
    reference.with({ day: reference.daysInMonth }).toString() +
    "."
  );
}

function valid<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function titlePhrase(title: string, value: unknown) {
  return typeof value === "string" && value.trim() && title.includes(value) ? value : undefined;
}

function timeZoneFor(title: string, value: unknown, fallback: string) {
  const zone = titlePhrase(title, value)?.trim();
  return zone ? (standardOffsets.get(zone.toUpperCase()) ?? zone) : fallback;
}

function localInstant(day: string, clock: string, timeZone: string) {
  return Temporal.PlainDate.from(day)
    .toPlainDateTime(clock)
    .toZonedDateTime(timeZone, { disambiguation: "reject" })
    .toInstant();
}

/** Clairic interprets the title. Only typed values reach the calendar conversion. */
export async function extractTaskTime(
  extract: TitleExtractor | undefined,
  title: string,
  context: TimingContext,
): Promise<TaskTiming> {
  if (!extract) return {};
  const reference = context.referenceDate
    ? Temporal.PlainDate.from(context.referenceDate)
    : Temporal.Now.plainDateISO(context.timeZone);
  const fallbackDay = context.defaultDate ?? reference.toString();
  const signal = AbortSignal.timeout(15_000);
  let values: Awaited<ReturnType<TitleExtractor>>;
  try {
    const state = "Task title: " + title + "\n\n" + calendarReference(reference);
    values = await extract(state, timingFields(!!context.deadline), signal, reference.toString());
  } catch {
    console.warn(JSON.stringify({ event: "task_time_extraction_unavailable" }));
    return {};
  }

  const result: TaskTiming = {};
  const minutes =
    typeof values.duration_seconds === "number"
      ? valid(duration, values.duration_seconds / 60)
      : undefined;
  if (minutes !== undefined) result.durationMinutes = minutes;

  const hasScheduledDate = !!titlePhrase(title, values.scheduled_date_phrase);
  const scheduledDate = hasScheduledDate ? valid(date, values.scheduled_date) : undefined;
  const startTime = valid(time, values.start_time);
  const endTime = titlePhrase(title, values.end_time_phrase) && valid(time, values.end_time);
  if (startTime && values.ambiguous_schedule !== true && (!hasScheduledDate || scheduledDate)) {
    try {
      const day = scheduledDate ?? fallbackDay;
      const timeZone = timeZoneFor(title, values.scheduled_time_zone, context.timeZone);
      const start = localInstant(day, startTime, timeZone);
      let end = start.add({ minutes: context.durationMinutes ?? minutes ?? 60 });
      if (endTime) {
        const overnight = Temporal.PlainTime.compare(endTime, startTime) < 0;
        const endDay = overnight ? Temporal.PlainDate.from(day).add({ days: 1 }).toString() : day;
        end = localInstant(endDay, endTime, timeZone);
      }
      if (Temporal.Instant.compare(start, end) < 0) {
        result.schedule = {
          type: "fixed",
          start: start.toString({ smallestUnit: "millisecond" }),
          end: end.toString({ smallestUnit: "millisecond" }),
        };
        if (endTime && minutes === undefined) {
          const elapsed = valid(duration, start.until(end).total("minutes"));
          if (elapsed !== undefined) result.durationMinutes = elapsed;
        }
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  } else if (
    scheduledDate &&
    values.start_time === undefined &&
    !endTime &&
    values.ambiguous_schedule !== true
  ) {
    result.schedule = { type: "day", date: scheduledDate };
  }

  if (!context.deadline && !titlePhrase(title, values.deadline_phrase)) return result;

  const dueDate = valid(date, values.due_date);
  const duePhrase = titlePhrase(title, values.due_time_phrase);
  let dueTime = duePhrase && valid(time, values.due_time);
  if (duePhrase && !dueTime) {
    try {
      const answer = await extract(
        duePhrase,
        [
          {
            path: "clock_time",
            modelKey: "clock_time",
            kind: "time",
            instructions:
              "Convert this unambiguous clock time to 24-hour HH:mm:ss. Return null if AM/PM is ambiguous.",
          },
        ],
        signal,
      );
      dueTime = valid(time, answer.clock_time);
    } catch {
      // Keep the inferred date when the clock could not be resolved.
    }
  }
  if (dueTime) {
    try {
      const timeZone = timeZoneFor(title, values.due_time_zone, context.timeZone);
      const at = localInstant(dueDate ?? fallbackDay, dueTime, timeZone);
      result.due = { type: "time", at: at.toString({ smallestUnit: "millisecond" }), timeZone };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  } else if (dueDate) {
    result.due = { type: "day", date: dueDate };
  }
  if (context.deadline && result.due && result.schedule) {
    // An unqualified deadline can also be returned by the work fields. Keep one projection.
    const duplicate =
      result.schedule.type === "day"
        ? result.schedule.date === (dueDate ?? fallbackDay)
        : result.schedule.type === "fixed" &&
          result.due.type === "time" &&
          result.schedule.start === result.due.at;
    if (duplicate) delete result.schedule;
  }
  return result;
}
