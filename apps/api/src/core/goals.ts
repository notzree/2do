import type { z } from "zod";
import type { GoalDatabase } from "../db/goals.ts";
import type { PlannerDatabase } from "../interfaces/database.ts";
import {
  goalProgress,
  validateGoalConfig,
  type GoalRecord,
  type PlannerGoal,
  type newPlannerGoal,
  type editPlannerGoal,
} from "../interfaces/goals.ts";
import { PluginReports } from "./plugin-reports.ts";
import { nextReportDay, reportingDay } from "../interfaces/plugin-reports.ts";
import { PlannerError } from "./planner.ts";
import type { TaskPlugins } from "./task-plugins.ts";

export class PlannerGoals {
  constructor(
    private readonly db: GoalDatabase,
    private readonly tasks: Pick<PlannerDatabase, "task">,
    private readonly plugins: TaskPlugins,
  ) {}
  private validate(subtype: GoalRecord["subtype"]) {
    if (!subtype) return;
    const type = this.plugins.enabledGoalType(subtype.typeId);
    if (!type || type.version !== subtype.version)
      throw new PlannerError(409, "Enable a compatible plugin to use this goal type.");
    validateGoalConfig(type, subtype.data);
    type.validate?.(subtype.data);
  }
  progress(id: string, day: string) {
    const row = this.db.row(id);
    if (!row) throw new PlannerError(404, "Goal not found.");
    return this.ruleProgress(id, row.document, day);
  }
  private ruleProgress(id: string, document: GoalRecord, day: string) {
    const sub = document.subtype;
    const def = sub && this.plugins.enabledGoalType(sub.typeId);
    let progress: PlannerGoal["progress"] = null;
    if (document.dailyMetric && !sub) {
      const reports = new PluginReports(this.plugins.db.reports, this.plugins);
      const saved = this.plugins.db.reports.goal(id);
      if (
        saved &&
        reports
          .metrics()
          .some(
            (m) => m.id === saved.document.metric.id && m.version === saved.document.metric.version,
          )
      ) {
        const today = reports.history(id, { from: day, to: nextReportDay(day) }).days[0];
        if (today) {
          const t = today.target;
          const target =
            t.comparator === "between"
              ? t.min + "–" + t.max
              : (t.comparator === "atLeast" ? "≥ " : "≤ ") + t.value;
          progress = {
            satisfied: false,
            label:
              (today.value === null
                ? "No data logged"
                : today.value + " " + saved.document.metric.unit + " logged") +
              " · Daily target " +
              target +
              " " +
              saved.document.metric.unit,
          };
        }
      }
    }
    if (sub && def && def.version === sub.version) {
      const today = day;
      const metrics = this.plugins
        .installations()
        .filter((p) => p.enabled)
        .flatMap((p) => p.metrics ?? [])
        .filter((m) => def.metrics.includes(m.id));
      progress = goalProgress.parse(
        def.evaluate(sub.data, this.db.observations(metrics, def.period(sub.data, today)), today),
      );
    }
    return progress;
  }
  private view(row: NonNullable<ReturnType<GoalDatabase["row"]>>): PlannerGoal {
    const { id, revision, document } = row;
    const links = this.db.links(id);
    const progress = this.ruleProgress(id, document, reportingDay(document.timeZone));
    return {
      ...document,
      id,
      revision,
      links,
      progress,
      checkIns: this.db.checkIns(id),
      achieved:
        document.manualAchievement ||
        links.some((l) => l.role === "satisfies" && l.completed) ||
        !!progress?.satisfied,
    };
  }
  list() {
    return this.db.rows().map((row) => this.view(row));
  }
  create(input: z.infer<typeof newPlannerGoal>) {
    return this.db.transaction(() => {
      const existing = this.db.row(input.id);
      const creation = JSON.stringify(input);
      if (existing) {
        if (existing.creation !== creation)
          throw new PlannerError(409, "This goal ID is already in use.");
        return this.view(existing);
      }
      this.validate(input.subtype ?? null);
      this.db.insert(input.id, creation, {
        title: input.title,
        targetDate: input.targetDate ?? null,
        nextCheckIn: input.nextCheckIn ?? null,
        timeZone: this.plugins.db.reports.timeZone(),
        subtype: input.subtype ?? null,
        manualAchievement: false,
        dailyMetric: null,
      });
      return this.view(this.db.row(input.id)!);
    });
  }
  edit(id: string, { revision, change }: z.infer<typeof editPlannerGoal>) {
    return this.db.transaction(() => {
      const row = this.db.row(id);
      if (!row) throw new PlannerError(404, "Goal not found.");
      if (row.revision !== revision)
        throw new PlannerError(409, "Goal changed. Reload before editing.");
      const doc = { ...row.document };
      switch (change.action) {
        case "edit":
          if (doc.dailyMetric && change.title.length > 120)
            throw new PlannerError(409, "Daily target names can have up to 120 characters.");
          if (change.subtype !== undefined) {
            this.validate(change.subtype);
            doc.subtype = change.subtype;
          }
          doc.title = change.title;
          doc.targetDate = change.targetDate;
          doc.nextCheckIn = change.nextCheckIn;
          break;
        case "achievement":
          doc.manualAchievement = change.achieved;
          break;
        case "check-in":
          this.db.checkIn(id, change.note);
          doc.nextCheckIn = change.nextCheckIn;
          break;
        case "subtype":
          this.validate(change.subtype);
          doc.subtype = change.subtype;
          break;
        case "link":
          if (!this.tasks.task(change.taskId)) throw new PlannerError(404, "Task not found.");
          this.db.link(id, change.taskId, change.role);
          break;
      }
      this.db.update(id, doc);
      return this.view(this.db.row(id)!);
    });
  }
}
