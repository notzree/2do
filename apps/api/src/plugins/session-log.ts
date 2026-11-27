import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import {
  reportingDay,
  type MetricDefinition,
  type MetricObservation,
} from "../interfaces/plugin-reports.ts";
import type { GoalSubtypeDefinition } from "../interfaces/goals.ts";
import type {
  ActionDefinition,
  PluginWorkflow,
  WorkflowSnapshot,
  PluginData,
} from "../interfaces/plugin-workflows.ts";

type Defaults = Record<string, string | number>;
export const metric = (id: string, label: string, unit: string): MetricDefinition => ({
  id,
  label,
  unit,
  version: 1,
  reducer: "sum",
});
export const dateField = { key: "day", kind: "date" as const, required: true, label: "Log date" };
export const minutesField = {
  key: "minutes",
  kind: "number" as const,
  min: 1,
  required: true,
  label: "Actual minutes",
};
export function logDay(task: WorkflowSnapshot["task"], zone: string, today: string) {
  return task.schedule?.type === "day"
    ? task.schedule.date
    : task.schedule
      ? reportingDay(zone, new Date(task.schedule.start))
      : today;
}
/** A command replaces one confirmed log. Edits to planned fields leave the recorded actuals intact. */
export function logWorkflow<T extends PluginData>(spec: {
  action: ActionDefinition;
  schema: z.ZodType<T>;
  defaults(current: WorkflowSnapshot): Defaults;
  record(input: PluginData, current: WorkflowSnapshot): T;
  form(entry: T): Defaults;
  properties?(entry: T | undefined): { label: string; value: string | null }[];
  measure(entry: T): MetricObservation[];
}): PluginWorkflow<PluginData, { entry?: T }> {
  const clear = { id: "clear", label: "Remove log", fields: [] };
  const summaryStatus = (state: { entry?: T }) => state.entry ? "Logged" : "Planned";
  return {
    version: 1,
    initial: {},
    schema: z.object({ entry: spec.schema.optional() }),
    commands: [spec.action, clear],
    summaryStatus,
    describe(current, state) {
      return {
        status: summaryStatus(state),
        properties: spec.properties?.(state.entry),
        actions: [
          {
            id: spec.action.id,
            defaults: state.entry ? spec.form(state.entry) : spec.defaults(current),
          },
          ...(state.entry ? [{ id: clear.id }] : []),
        ],
      };
    },
    transition(_, current, state, event) {
      if (event.kind !== "command") return { state };
      return {
        confirmSubtype: event.id === spec.action.id,
        state:
          event.id === clear.id
            ? {}
            : { entry: spec.schema.parse(spec.record(event.input, current)) },
      };
    },
    measure(_, state) {
      return state.entry ? spec.measure(state.entry) : [];
    },
  };
}
export function weeklySessions(id: string, label: string, metricId: string): GoalSubtypeDefinition {
  return {
    id,
    label,
    version: 1,
    fields: [{ key: "count", kind: "number", min: 1, integer: true, label: "Sessions per week" }],
    metrics: [metricId],
    period(_, today) {
      const day = Temporal.PlainDate.from(today),
        start = day.subtract({ days: day.dayOfWeek - 1 });
      return { from: start.toString(), to: start.add({ weeks: 1 }).toString() };
    },
    evaluate(data, rows, today) {
      const total = new Set(
        rows.filter((r) => r.day <= today && r.value === 1).map((r) => r.taskId),
      ).size;
      return {
        label: total + " of " + data.count + " sessions this week (Mon–Sun)",
        satisfied: false,
      };
    },
  };
}
