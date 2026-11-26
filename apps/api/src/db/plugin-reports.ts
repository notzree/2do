import { GoalDatabase } from "./goals.ts";
import { PlannerError } from "../core/planner.ts";
import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import {
  goal,
  metricObservation,
  type Goal,
  type MetricDefinition,
  type MetricObservation,
} from "../interfaces/plugin-reports.ts";
import type { PlannerStore } from "./planner.ts";
import {
  metricObservations as observations,
  reportCalendar,
  reportGoals,
} from "./report-schema.ts";

export class SqlitePluginReportDatabase {
  constructor(private readonly store: PlannerStore) {}

  transaction<T>(write: () => T) {
    return this.store.transaction(write);
  }

  settings() {
    const row = this.store.select().from(reportCalendar).where(eq(reportCalendar.id, 1)).get();
    return { timeZone: row?.timeZone ?? null };
  }

  timeZone() {
    return this.settings().timeZone ?? "UTC";
  }

  setTimeZone(timeZone: string, onlyIfUnset = false) {
    const write = this.store.insert(reportCalendar).values({ id: 1, timeZone });
    if (onlyIfUnset) write.onConflictDoNothing().run();
    else write.onConflictDoUpdate({ target: reportCalendar.id, set: { timeZone } }).run();
    return this.settings();
  }

  hasObservations(taskId: string) {
    return !!this.store.select({ id: observations.taskId }).from(observations)
      .where(eq(observations.taskId, taskId)).limit(1).get();
  }

  replaceObservations(
    taskId: string,
    typeId: string,
    revision: string,
    values: readonly MetricObservation[],
  ) {
    this.transaction(() => {
      this.store
        .delete(observations)
        .where(and(eq(observations.taskId, taskId), eq(observations.typeId, typeId)))
        .run();
      for (const value of values) {
        this.store
          .insert(observations)
          .values({ taskId, typeId, revision, ...metricObservation.parse(value) })
          .run();
      }
    });
  }

  daily(metrics: readonly MetricDefinition[], from: string, to: string) {
    const grouped = new Map<
      string,
      Map<string, { value: number | null; known: number; unknown: number }>
    >();
    // Two bind parameters per metric plus the date range; stay within SQLite's variable limit.
    for (let start = 0; start < metrics.length; start += 32) {
      const matches = metrics
        .slice(start, start + 32)
        .map((metric) =>
          and(eq(observations.metricId, metric.id), eq(observations.metricVersion, metric.version)),
        );
      const rows = this.store
        .select({
          metricId: observations.metricId,
          day: observations.day,
          value: sql<number | null>`sum(${observations.value})`,
          known: sql<number>`count(${observations.value})`,
          unknown: sql<number>`count(*) - count(${observations.value})`,
        })
        .from(observations)
        .where(and(or(...matches), gte(observations.day, from), lt(observations.day, to)))
        .groupBy(observations.metricId, observations.day)
        .all();
      for (const { metricId, day, ...coverage } of rows) {
        const days = grouped.get(metricId) ?? new Map();
        days.set(day, coverage);
        grouped.set(metricId, days);
      }
    }
    return grouped;
  }

  goals() {
    return this.store
      .select({ document: reportGoals.document })
      .from(reportGoals)
      .orderBy(reportGoals.id)
      .all()
      .map(({ document }) => goal.parse(document));
  }

  goal(id: string) {
    const row = this.store.select().from(reportGoals).where(eq(reportGoals.id, id)).get();
    return row && { document: goal.parse(row.document), creation: row.creation };
  }

  createGoal(document: Goal, creation: string) {
    const core = new GoalDatabase(this.store);
    if (core.row(document.id)) throw new PlannerError(409, "This goal ID is already in use.");
    core.insert(document.id, creation, { title: document.label, manualAchievement: false, dailyMetric: document.metric.id,
      timeZone: document.timeZone, nextCheckIn: null, targetDate: null, subtype: null });
    this.store.insert(reportGoals).values({ id: document.id, document, creation }).run();
  }

  updateGoal(document: Goal) {
    this.store.update(reportGoals).set({ document }).where(eq(reportGoals.id, document.id)).run();
  }
}
