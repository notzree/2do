import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Goal } from "../interfaces/plugin-reports.ts";
import { tasks } from "./schema.ts";

export const metricObservations = sqliteTable(
  "plugin_metric_observation",
  {
    taskId: text()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    typeId: text().notNull(),
    sourceKey: text().notNull(),
    metricId: text().notNull(),
    metricVersion: integer().notNull(),
    day: text().notNull(),
    value: real(),
    revision: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.typeId, t.sourceKey, t.metricId] }),
    index("plugin_metric_period").on(t.metricId, t.metricVersion, t.day),
  ],
);

export const reportCalendar = sqliteTable("plugin_report_calendar", {
  id: integer().primaryKey(),
  timeZone: text().notNull(),
});

export const reportGoals = sqliteTable("plugin_goal", {
  id: text().primaryKey(),
  creation: text().notNull(),
  document: text({ mode: "json" }).$type<Goal>().notNull(),
});
