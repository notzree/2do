import { and, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import type { RecordedWorkout } from "../interfaces/connectors.ts";
import { reportingDay } from "../interfaces/plugin-reports.ts";
import { activityObservations } from "../plugins/fitness.ts";
import type { PlannerStore } from "./planner.ts";
import { connectedWorkouts, connectedWorkoutMetrics, metricObservations } from "./report-schema.ts";

// Keep wearable records out of task capture and classification. Reports and goal rules
// see one stable observation source per workout, just as they do for a manual log.
export function reportObservations(store: PlannerStore) {
  const manual = metricObservations,
    imported = connectedWorkoutMetrics;
  return store
    .select({
      taskId: manual.taskId,
      sourceKey: manual.sourceKey,
      metricId: manual.metricId,
      metricVersion: manual.metricVersion,
      day: manual.day,
      value: manual.value,
    })
    .from(manual)
    .unionAll(
      store
        .select({
          taskId: imported.workoutId,
          sourceKey: sql<string>`'activity'`.as("sourceKey"),
          metricId: imported.metricId,
          metricVersion: imported.metricVersion,
          day: imported.day,
          value: imported.value,
        })
        .from(imported),
    )
    .as("report_observations");
}

export class FitnessImports {
  constructor(private readonly store: PlannerStore) {}

  apply(account: string, scan: string, rows: RecordedWorkout[], complete: boolean, zone: string) {
    return this.store.transaction(() => {
      let changed = false;
      for (const row of rows) {
        const day = reportingDay(zone, new Date(row.start));
        const table = connectedWorkouts;
        const previous = this.store.select().from(table).where(eq(table.id, row.id)).get();
        if (previous && previous.account !== account) throw new Error("Workout account changed");
        if (
          previous &&
          previous.start === row.start &&
          previous.activity === row.activity &&
          previous.minutes === row.minutes &&
          previous.elapsedMinutes === row.elapsedMinutes &&
          previous.km === row.km &&
          previous.running === row.running &&
          previous.day === day
        ) {
          if (previous.scan !== scan)
            this.store.update(table).set({ scan }).where(eq(table.id, row.id)).run();
          continue;
        }
        const values = { ...row, account, scan, day };
        this.store
          .insert(table)
          .values(values)
          .onConflictDoUpdate({ target: table.id, set: values })
          .run();
        this.store
          .delete(connectedWorkoutMetrics)
          .where(eq(connectedWorkoutMetrics.workoutId, row.id))
          .run();
        const observations = activityObservations({ ...row, day }, row.running, row.elapsedMinutes);
        this.store
          .insert(connectedWorkoutMetrics)
          .values(observations.map(({ sourceKey, ...value }) => ({ workoutId: row.id, ...value })))
          .run();
        changed = true;
      }
      // A partial or failed scan can never retract a previously imported workout.
      if (complete) {
        const removed = this.remove(
          and(eq(connectedWorkouts.account, account), ne(connectedWorkouts.scan, scan))!,
        );
        changed ||= removed;
      }
      return changed;
    });
  }

  private remove(where: SQL) {
    if (
      !this.store
        .select({ id: connectedWorkouts.id })
        .from(connectedWorkouts)
        .where(where)
        .limit(1)
        .get()
    )
      return false;
    this.store.delete(connectedWorkouts).where(where).run();
    return true;
  }

  clear(account: string) {
    return this.remove(eq(connectedWorkouts.account, account));
  }

  recent() {
    const w = connectedWorkouts;
    return this.store
      .select({ activity: w.activity, start: w.start, minutes: w.minutes, km: w.km })
      .from(w)
      .orderBy(desc(w.start), w.id)
      .limit(5)
      .all();
  }
}
