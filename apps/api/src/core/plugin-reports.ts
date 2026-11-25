import type { z } from "zod";
import type { SqlitePluginReportDatabase } from "../db/plugin-reports.ts";
import {
  nextReportDay,
  reportingDay,
  type createGoal,
  type updateGoal,
  type metricSeriesQuery,
  type reportRange,
  type Goal,
  type GoalHistory,
  type GoalTarget,
  type MetricDefinition,
  type MetricSeries,
} from "../interfaces/plugin-reports.ts";
import { PlannerError } from "./planner.ts";

type Range = z.infer<typeof reportRange>;
type SeriesQuery = z.infer<typeof metricSeriesQuery>;
type DailyCoverage = { value: number | null; known: number; unknown: number };
const empty: DailyCoverage = { value: null, known: 0, unknown: 0 };

function newBucket(
  day: string,
  bucket: SeriesQuery["bucket"],
  weekStart: SeriesQuery["weekStart"],
) {
  if (bucket === "month") return day.endsWith("-01");
  if (bucket === "week") return new Date(day).getUTCDay() === Number(weekStart);
  return true;
}

function meets(target: GoalTarget, value: number) {
  switch (target.comparator) {
    case "atLeast":
      return value >= target.value;
    case "atMost":
      return value <= target.value;
    case "between":
      return value >= target.min && value <= target.max;
  }
}

function evaluate(
  goal: Goal,
  range: Range,
  today: string,
  observations?: Map<string, DailyCoverage>,
): GoalHistory {
  const result: GoalHistory = {
    goal,
    days: [],
    counts: { met: 0, missed: 0, unknown: 0, inProgress: 0 },
  };
  let index = 0;
  const start = goal.versions[0].effectiveFrom;
  for (
    let day = start > range.from ? start : range.from;
    day < range.to && day <= today;
    day = nextReportDay(day)
  ) {
    while (goal.versions[index + 1]?.effectiveFrom <= day) index++;
    const { target } = goal.versions[index];
    if (!target) continue;
    const coverage = observations?.get(day) ?? empty;
    const outcome =
      day === today
        ? "inProgress"
        : coverage.value === null || coverage.unknown > 0
          ? "unknown"
          : meets(target, coverage.value)
            ? "met"
            : "missed";
    result.days.push({ day, ...coverage, target, outcome });
    result.counts[outcome]++;
  }
  return result;
}

type PluginCatalog = {
  installations(): readonly { enabled: boolean; metrics?: readonly MetricDefinition[] }[];
};

export class PluginReports {
  constructor(
    readonly db: SqlitePluginReportDatabase,
    private readonly plugins: PluginCatalog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  metrics() {
    return this.plugins
      .installations()
      .filter((p) => p.enabled)
      .flatMap((p) => p.metrics ?? []);
  }

  private metric(id: string) {
    const metric = this.metrics().find((m) => m.id === id);
    if (!metric) throw new PlannerError(404, "Enabled plugin metric not found.");
    return metric;
  }

  series(metricId: string, { from, to, bucket, weekStart }: SeriesQuery): MetricSeries {
    const metric = this.metric(metricId);
    const rows = this.db.daily([metric], from, to).get(metricId);
    const buckets: MetricSeries["buckets"] = [];
    for (let day = from; day < to; day = nextReportDay(day)) {
      if (!buckets.length || newBucket(day, bucket, weekStart))
        buckets.push({ from: day, to: day, ...empty });
      const current = buckets[buckets.length - 1];
      current.to = nextReportDay(day);
      const row = rows?.get(day);
      if (!row) continue;
      current.known += row.known;
      current.unknown += row.unknown;
      if (row.value !== null) current.value = (current.value ?? 0) + row.value;
    }
    return { metric, buckets };
  }

  goals() {
    const enabled = new Map(this.metrics().map((m) => [m.id, m.version]));
    return this.db.goals().filter((g) => enabled.get(g.metric.id) === g.metric.version);
  }

  private visibleGoal(id: string) {
    const saved = this.db.goal(id);
    if (!saved || this.metric(saved.document.metric.id).version !== saved.document.metric.version)
      throw new PlannerError(404, "Goal not found.");
    return saved;
  }

  create(input: z.infer<typeof createGoal>): Goal {
    return this.db.transaction(() => {
      const metric = this.metric(input.metricId);
      const creation = JSON.stringify(input);
      const existing = this.db.goal(input.id);
      if (existing) {
        if (existing.creation !== creation || existing.document.metric.version !== metric.version)
          throw new PlannerError(409, "This goal ID already belongs to a different target.");
        return existing.document;
      }
      const goal: Goal = {
        id: input.id,
        label: input.label,
        metric,
        timeZone: this.db.timeZone(),
        revision: crypto.randomUUID(),
        versions: [{ effectiveFrom: input.effectiveFrom, target: input.target }],
      };
      this.db.createGoal(goal, creation);
      return goal;
    });
  }

  update(id: string, { revision, effectiveFrom, target }: z.infer<typeof updateGoal>): Goal {
    return this.db.transaction(() => {
      const { document } = this.visibleGoal(id);
      if (document.revision !== revision)
        throw new PlannerError(409, "Goal changed. Reload before editing.");
      if (effectiveFrom < document.versions[0].effectiveFrom)
        throw new PlannerError(409, "The change precedes the start of this goal.");
      const versions = document.versions.filter((v) =>
        target ? v.effectiveFrom !== effectiveFrom : v.effectiveFrom < effectiveFrom,
      );
      versions.push({ effectiveFrom, target });
      versions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      const updated = { ...document, versions, revision: crypto.randomUUID() };
      this.db.updateGoal(updated);
      return updated;
    });
  }

  private histories(goals: Goal[], range: Range) {
    const distinct = new Map(goals.map((g) => [g.metric.id, g.metric]));
    const rows = this.db.daily([...distinct.values()], range.from, range.to);
    const now = this.now();
    const todayByZone = new Map<string, string>();
    return goals.map((g) => {
      const today = todayByZone.get(g.timeZone) ?? reportingDay(g.timeZone, now);
      todayByZone.set(g.timeZone, today);
      return evaluate(g, range, today, rows.get(g.metric.id));
    });
  }

  history(id: string, range: Range) {
    return this.histories([this.visibleGoal(id).document], range)[0];
  }

  allHistory(range: Range) {
    return this.histories(this.goals(), range);
  }
}
