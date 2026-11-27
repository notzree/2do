import { z } from "zod";
import type { TaskPlugin } from "../interfaces/task-plugins.ts";
import { choiceField, numberField, textField } from "../interfaces/plugin-fields.ts";
import {
  dateField,
  logDay,
  logWorkflow,
  metric,
  minutesField,
  weeklySessions,
} from "./session-log.ts";

const kind = choiceField({
  key: "activityKind",
  label: "Activity kind",
  options: ["strength", "cardio", "sport", "mobility", "mixed", "other"],
  inlayLabel: "Kind",
});
const activity = textField({
  key: "activity",
  label: "Activity",
  maxLength: 100,
  inlayLabel: "Activity",
});
const km = numberField({
  key: "distanceKm",
  label: "Planned distance (km)",
  min: 0,
  inlayLabel: "Km",
});
const data = z.strictObject({
  activity: activity.schema.optional(),
  activityKind: kind.schema.optional(),
  distanceKm: km.schema.optional(),
});
const log = z.strictObject({
  day: z.iso.date(),
  minutes: z.number().positive(),
  km: z.number().nonnegative().optional(),
  activity: z.string(),
});
export function activityObservations(
  e: { day: string; minutes: number; km?: number | null; activity: string },
  running = /\b(run|running|jog|jogging)\b/i.test(e.activity),
  elapsedMinutes = e.minutes,
) {
  const facts: Record<string, number | null> = {
    sessions: 1,
    minutes: e.minutes,
    distance: e.km ?? null,
  };
  if (running) {
    facts["run-distance"] = e.km ?? null;
    facts["run-minutes"] = elapsedMinutes;
  }
  return Object.entries(facts).map(([id, value]) => ({
    metricId: "fitness." + id,
    metricVersion: 1,
    sourceKey: "activity",
    day: e.day,
    value,
  }));
}

const workflow = logWorkflow({
  schema: log,
  action: {
    id: "log",
    label: "Log activity",
    fields: [
      dateField,
      minutesField,
      {
        kind: "text",
        key: "activity",
        label: "Activity performed",
        maxLength: 100,
        required: true,
      },
      { kind: "number", key: "km", label: "Actual distance (km)", min: 0 },
    ],
  },
  defaults({ task, data, timeZone, today }) {
    const d: Record<string, string | number> = { day: logDay(task, timeZone, today) };
    if (task.durationMinutes) d.minutes = task.durationMinutes;
    if (typeof data.activity === "string") d.activity = data.activity;
    if (typeof data.distanceKm === "number") d.km = data.distanceKm;
    return d;
  },
  record(input) {
    return log.parse(input);
  },
  form(e) {
    return { ...e } as Record<string, string | number>;
  },
  measure: activityObservations,
});
export const fitnessPlugin: TaskPlugin = {
  id: "fitness",
  label: "Fitness",
  description: "Plan activity, log training and track fitness goals.",
  metrics: [
    metric("fitness.sessions", "Activities", "sessions"),
    metric("fitness.minutes", "Active minutes", "min"),
    metric("fitness.distance", "Distance", "km"),
    metric("fitness.run-distance", "Running distance", "km"),
    metric("fitness.run-minutes", "Running time", "min"),
  ],
  subtypes: [
    {
      id: "fitness.activity",
      label: "Activity",
      icon: "activity",
      captureCommand: "activity",
      captureAliases: {
        workout: {},
        cardio: { activityKind: "cardio" },
        sport: { activityKind: "sport" },
      },
      schemaVersion: 1,
      schema: data,
      initialData: {},
      view: (_, v) => v,
      classification: {
        instructions:
          "Is the user doing physical exercise, training, active recreation or playing a sport? Include lifting, running, mobility and games the user plays. Exclude watching sports, buying gear, and working on fitness-related documents.",
      },
      editor: [{ fields: [activity.field, kind.field, km.field] }],
      extraction: {
        activity:
          "Name of the physical activity or sport performed, copied from the title. Omit when only a generic workout is mentioned.",
      },
      fromTitle(text) {
        const kinds = [
          [/\b(run|running|jog|ride|cycling|swim|swimming)\b/i, "cardio"],
          [/\b(lift|lifting|strength|weights|squats)\b/i, "strength"],
          [/\b(soccer|tennis|basketball|hockey|volleyball|badminton)\b/i, "sport"],
          [/\b(yoga|stretch|mobility)\b/i, "mobility"],
        ] as const;
        const found = kinds.filter(([r]) => r.test(text));
        const dist = /\b(\d+(?:\.\d+)?)\s*(km|kilomet(?:er|re)s?|mi|miles?)\b/i.exec(text);
        return {
          ...(found.length ? { activityKind: found.length > 1 ? "mixed" : found[0][1] } : {}),
          ...(dist ? { distanceKm: Number(dist[1]) * (/^mi/i.test(dist[2]) ? 1.609344 : 1) } : {}),
        };
      },
      workflow,
    },
  ],
  goalSubtypes: [
    weeklySessions("fitness.weekly-activity", "Weekly activities", "fitness.sessions"),
    {
      id: "fitness.run-performance",
      label: "Run a distance within a time",
      version: 1,
      fields: [
        { key: "km", kind: "number", label: "Distance (km)", min: 0.01 },
        { key: "minutes", kind: "number", label: "Maximum minutes", min: 0.01 },
      ],
      metrics: ["fitness.run-distance", "fitness.run-minutes"],
      period() {
        return undefined;
      },
      evaluate(config, rows, today) {
        const times = new Map(
          rows
            .filter((r) => r.metricId === "fitness.run-minutes" && r.day <= today)
            .map((r) => [r.taskId, r.value]),
        );
        const hit = rows.some(
          (r) =>
            r.day <= today &&
            r.metricId === "fitness.run-distance" &&
            r.value !== null &&
            r.value >= Number(config.km) &&
            (times.get(r.taskId) ?? Infinity) <= Number(config.minutes),
        );
        return {
          satisfied: hit,
          label: hit ? "Qualifying run logged" : "Awaiting a qualifying run",
        };
      },
    },
  ],
};
