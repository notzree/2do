import { z } from "zod";
import type { TaskPlugin } from "../interfaces/task-plugins.ts";
import { textField } from "../interfaces/plugin-fields.ts";
import {
  dateField,
  logDay,
  logWorkflow,
  metric,
  minutesField,
  weeklySessions,
} from "./session-log.ts";
const project = textField({
  key: "project",
  label: "Project / courses",
  maxLength: 120,
  inlayLabel: "Project",
});
const entry = z.strictObject({ day: z.iso.date(), minutes: z.number().positive() });
export const productivityPlugin: TaskPlugin = {
  id: "productivity",
  label: "Productivity",
  description: "Plan focused work and track deliverables.",
  metrics: [
    metric("productivity.sessions", "Work sessions", "sessions"),
    metric("productivity.minutes", "Focus time", "min"),
  ],
  goalSubtypes: [
    weeklySessions("productivity.weekly-work", "Weekly work sessions", "productivity.sessions"),
  ],
  subtypes: [
    {
      id: "productivity.work-session",
      label: "Work session",
      captureCommand: "work",
      icon: "book",
      schemaVersion: 1,
      schema: z.strictObject({ project: project.schema.optional() }),
      initialData: {},
      view: (_, data) => data,
      editor: [{ fields: [project.field] }],
      extraction: { project: "Explicitly named course or project. Omit when absent." },
      classification: {
        instructions:
          "Does the task describe the user spending time on school or professional work? Writing a draft, coding, studying, or reviewing material during a time block counts, even if the title never says session. A submission due date, a quick errand, a purchase or physical exercise alone does not count.",
      },
      workflow: logWorkflow({
        schema: entry,
        action: { id: "log", label: "Log session", fields: [dateField, minutesField] },
        properties: (entry) => [{ label: "Duration", value: entry ? entry.minutes + " min" : null }],
        defaults({ task, timeZone, today }) {
          const d: Record<string, string | number> = { day: logDay(task, timeZone, today) };
          if (task.durationMinutes) d.minutes = task.durationMinutes;
          return d;
        },
        record: (input) => entry.parse(input),
        form: (e) => e,
        measure: (e) =>
          [
            ["sessions", 1],
            ["minutes", e.minutes],
          ].map(([id, value]) => ({
            metricId: "productivity." + id,
            metricVersion: 1,
            sourceKey: "work",
            day: e.day,
            value: Number(value),
          })),
      }),
    },
    {
      id: "productivity.deadline",
      label: "Deliverable deadline",
      captureCommand: "deadline",
      captureTiming: "deadline",
      icon: "calendar",
      schemaVersion: 1,
      schema: z.strictObject({}),
      initialData: {},
      view: (task) => task,
      classification: {
        instructions:
          "Does this describe a specific deliverable that must be submitted, sent or finished by a stated deadline? Include a named assignment or work deliverable due on a date. Exclude ordinary scheduled work sessions, appointments and open-ended aspirations.",
      },
    },
  ],
};
