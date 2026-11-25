import { z } from "zod";

// Kept independent of task-plugins: plugin manifests embed these definitions.
const metricId = z.string().regex(/^[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/);
export const metricDefinition = z.strictObject({
  id: metricId,
  version: z.int().positive(),
  label: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(40),
  reducer: z.literal("sum"),
});
export type MetricDefinition = z.infer<typeof metricDefinition>;

export const metricObservation = z.strictObject({
  sourceKey: z.string().min(1).max(128),
  metricId,
  metricVersion: z.int().positive(),
  day: z.iso.date(),
  value: z.number().nullable(),
});
export type MetricObservation = z.infer<typeof metricObservation>;

export const reportingZone = z
  .string()
  .min(1)
  .max(128)
  .refine((zone) => {
    if (/^[+-]/.test(zone)) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "Use an IANA time zone, such as America/Toronto");
export const reportSettings = z.strictObject({ timeZone: reportingZone.nullable() });
export const writeReportSettings = z.strictObject({
  timeZone: reportingZone,
  onlyIfUnset: z.boolean().optional(),
});
export type ReportSettings = z.infer<typeof reportSettings>;

const dates = { from: z.iso.date(), to: z.iso.date() };
const dayMs = 86_400_000;
function bounded({ from, to }: { from: string; to: string }) {
  return from < to && Date.parse(to) - Date.parse(from) <= 366 * dayMs;
}
const boundsMessage = "Choose a positive date range of up to 366 days; the end date is exclusive.";
export const reportRange = z.object(dates).refine(bounded, boundsMessage);
export const metricSeriesQuery = z
  .object({
    ...dates,
    bucket: z.enum(["day", "week", "month"]).default("day"),
    weekStart: z.enum(["0", "1"]).default("0"),
  })
  .refine(bounded, boundsMessage);

const coverage = {
  value: z.number().nullable(),
  known: z.int().nonnegative(),
  unknown: z.int().nonnegative(),
};
export const metricSeries = z.strictObject({
  metric: metricDefinition,
  buckets: z.array(z.strictObject({ ...dates, ...coverage })),
});
export type MetricSeries = z.infer<typeof metricSeries>;

export const goalTarget = z.discriminatedUnion("comparator", [
  z.strictObject({ comparator: z.literal("atLeast"), value: z.number() }),
  z.strictObject({ comparator: z.literal("atMost"), value: z.number() }),
  z
    .strictObject({ comparator: z.literal("between"), min: z.number(), max: z.number() })
    .refine(({ min, max }) => min <= max, "The lower bound must be at most the upper bound"),
]);
export type GoalTarget = z.infer<typeof goalTarget>;
const goalVersion = z.strictObject({ effectiveFrom: z.iso.date(), target: goalTarget.nullable() });
export const goal = z.strictObject({
  id: z.uuid(),
  label: z.string().trim().min(1).max(120),
  revision: z.uuid(),
  metric: metricDefinition,
  timeZone: reportingZone,
  versions: z.array(goalVersion).min(1),
});
export const createGoal = z.strictObject({
  id: z.uuid(),
  metricId,
  label: goal.shape.label,
  effectiveFrom: z.iso.date(),
  target: goalTarget,
});
export const updateGoal = goalVersion.extend({ revision: z.uuid() });
export type Goal = z.infer<typeof goal>;

export const goalOutcome = z.enum(["met", "missed", "unknown", "inProgress"]);
export const goalHistory = z.strictObject({
  goal,
  counts: z.strictObject({ met: z.int(), missed: z.int(), unknown: z.int(), inProgress: z.int() }),
  days: z.array(
    z.strictObject({ day: z.iso.date(), ...coverage, target: goalTarget, outcome: goalOutcome }),
  ),
});
export type GoalHistory = z.infer<typeof goalHistory>;

// Report keys are civil days. UTC arithmetic here advances labels, never instants in a reporting zone.
export function nextReportDay(day: string) {
  const date = new Date(day);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
export function reportingDay(timeZone: string, instant: Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
