import { and, asc, eq, gte, inArray, lt, or } from "drizzle-orm";
import type { PlannerStore } from "./planner.ts";
import {
  goalCheckIns,
  goalLinks,
  metricObservations,
  plannerGoals,
  reportGoals,
  tasks,
} from "./schema.ts";
import type { GoalRecord } from "../interfaces/goals.ts";
import type { MetricDefinition } from "../interfaces/plugin-reports.ts";

export class GoalDatabase {
  constructor(private readonly store: PlannerStore) {}
  transaction<T>(write: () => T) {
    return this.store.transaction(write);
  }
  rows() {
    return this.store.select().from(plannerGoals).orderBy(plannerGoals.id).all();
  }
  row(id: string) {
    return this.store.select().from(plannerGoals).where(eq(plannerGoals.id, id)).get();
  }
  insert(id: string, creation: string, document: GoalRecord) {
    this.store
      .insert(plannerGoals)
      .values({ id, creation, document, revision: crypto.randomUUID() })
      .run();
  }
  update(id: string, document: GoalRecord) {
    this.store
      .update(plannerGoals)
      .set({ document, revision: crypto.randomUUID() })
      .where(eq(plannerGoals.id, id))
      .run();
    if (document.dailyMetric) {
      const metric = this.store.select().from(reportGoals).where(eq(reportGoals.id, id)).get();
      if (metric && metric.document.label !== document.title)
        this.store
          .update(reportGoals)
          .set({
            document: { ...metric.document, label: document.title, revision: crypto.randomUUID() },
          })
          .where(eq(reportGoals.id, id))
          .run();
    }
  }
  links(id: string) {
    return this.store
      .select({ task: tasks.document, role: goalLinks.role })
      .from(goalLinks)
      .innerJoin(tasks, eq(tasks.id, goalLinks.taskId))
      .where(eq(goalLinks.goalId, id))
      .orderBy(tasks.id)
      .all()
      .map(({ task, role }) => ({
        taskId: task.id,
        title: task.title,
        completed: task.completed,
        role,
      }));
  }
  link(goalId: string, taskId: string, role: "contributes" | "satisfies" | null) {
    if (role === null)
      this.store
        .delete(goalLinks)
        .where(and(eq(goalLinks.goalId, goalId), eq(goalLinks.taskId, taskId)))
        .run();
    else
      this.store
        .insert(goalLinks)
        .values({ goalId, taskId, role })
        .onConflictDoUpdate({ target: [goalLinks.goalId, goalLinks.taskId], set: { role } })
        .run();
  }
  checkIns(id: string) {
    return this.store
      .select({ at: goalCheckIns.at, note: goalCheckIns.note })
      .from(goalCheckIns)
      .where(eq(goalCheckIns.goalId, id))
      .orderBy(asc(goalCheckIns.id))
      .all();
  }
  checkIn(goalId: string, note: string) {
    this.store.insert(goalCheckIns).values({ goalId, note, at: new Date().toISOString() }).run();
  }
  observations(metrics: MetricDefinition[], period?: { from: string; to: string }) {
    const o = metricObservations;
    if (!metrics.length) return [];
    return this.store
      .select({
        taskId: o.taskId,
        sourceKey: o.sourceKey,
        day: o.day,
        metricId: o.metricId,
        value: o.value,
      })
      .from(o)
      .where(
        and(
          or(...metrics.map((m) => and(eq(o.metricId, m.id), eq(o.metricVersion, m.version)))),
          period && gte(o.day, period.from),
          period && lt(o.day, period.to),
        ),
      )
      .all();
  }
}
