import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vite-plus/test";
import { Planner } from "../src/core/planner.ts";
import { PluginReports } from "../src/core/plugin-reports.ts";
import { SqlitePlannerDatabase, type PlannerStore } from "../src/db/planner.ts";
import { SqlitePluginReportDatabase } from "../src/db/plugin-reports.ts";
import { createTask } from "../src/interfaces/plan.ts";
import { goal, metricDefinition, type MetricDefinition } from "../src/interfaces/plugin-reports.ts";

const protein: MetricDefinition = {
  id: "nutrition.protein",
  label: "Protein",
  unit: "g",
  version: 1,
  reducer: "sum",
};
const study: MetricDefinition = {
  id: "study.minutes",
  label: "Study time",
  unit: "min",
  version: 1,
  reducer: "sum",
};

async function fixture(test: (ctx: ReturnType<typeof setup>) => void) {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (_, state) => test(setup(drizzle(state.storage))));
}
function setup(store: PlannerStore) {
  const db = new SqlitePluginReportDatabase(store);
  const planner = new Planner(new SqlitePlannerDatabase(store));
  const plugins = [
    { enabled: true, metrics: [protein] },
    { enabled: true, metrics: [study] },
  ];
  const reports = new PluginReports(
    db,
    { installations: () => plugins },
    () => new Date("2026-03-09T03:30:00Z"),
  );
  db.setTimeZone("America/Toronto");
  function put(day: string, value: number | null, metric = protein, taskId?: string) {
    const id = taskId ?? planner.create(createTask.parse({ title: "Example" })).id;
    db.replaceObservations(id, metric.id, crypto.randomUUID(), [
      { sourceKey: "entry", metricId: metric.id, metricVersion: metric.version, day, value },
    ]);
    return id;
  }
  return { db, planner, reports, put, plugins };
}

it("groups all recorded sources by civil date with coverage, week start and clipped month buckets", async () => {
  await fixture(({ reports, put, planner }) => {
    for (let i = 0; i < 51; i++) put("2026-02-28", 1);
    const first = put("2026-03-01", 25);
    const second = put("2026-03-01", 40);
    put("2026-03-02", null);
    put("2026-03-02", 0);
    put("2026-03-02", 900, study);
    put("2026-03-04", 1000); // outside exclusive end
    const range = { from: "2026-02-28", to: "2026-03-04", weekStart: "1" as const };
    const daily = () => reports.series(protein.id, { ...range, bucket: "day" }).buckets;
    expect(daily().map(({ value, known, unknown }) => [value, known, unknown])).toEqual([
      [51, 51, 0],
      [65, 2, 0],
      [0, 1, 1],
      [null, 0, 0],
    ]);
    expect(
      reports
        .series(protein.id, { ...range, bucket: "week" })
        .buckets.map((b) => [b.from, b.to, b.value]),
    ).toEqual([
      ["2026-02-28", "2026-03-02", 116],
      ["2026-03-02", "2026-03-04", 0],
    ]);
    const monthly = reports.series(protein.id, { ...range, bucket: "month" }).buckets;
    expect(monthly.map((b) => [b.from, b.to, b.value, b.known, b.unknown])).toEqual([
      ["2026-02-28", "2026-03-01", 51, 51, 0],
      ["2026-03-01", "2026-03-04", 65, 3, 1],
    ]);
    expect(
      reports.series(protein.id, { ...range, bucket: "week", weekStart: "0" }).buckets,
    ).toEqual(monthly);
    put("2026-03-01", 30, protein, second);
    expect(daily()[1].value).toBe(55);
    put("2026-02-28", 30, protein, second);
    expect(daily().map((b) => b.value)).toEqual([81, 25, 0, null]);
    planner.remove(first);
    expect(daily()[1]).toMatchObject({ value: null, known: 0 });
  });
});

it("counts daily targets in their effective intervals, including partial, empty, zero, today and inactive days", async () => {
  await fixture(({ db, reports, put, plugins }) => {
    const first = put("2026-03-03", 65);
    put("2026-03-04", 55);
    put("2026-03-06", 0);
    put("2026-03-07", 80);
    put("2026-03-07", null);
    put("2026-03-08", 70);
    put("2026-03-08", 20, study);
    const g = reports.create({
      id: crypto.randomUUID(),
      label: "Protein goal",
      metricId: protein.id,
      effectiveFrom: "2026-03-03",
      target: { comparator: "atLeast", value: 60 },
    });
    const range = { from: "2026-03-01", to: "2026-03-12" };
    expect(reports.history(g.id, range).counts).toEqual({
      met: 1,
      missed: 2,
      unknown: 2,
      inProgress: 1,
    });
    put("2026-03-03", 55, protein, first);
    expect(reports.history(g.id, range).counts.met).toBe(0);
    const changed = reports.update(g.id, {
      revision: g.revision,
      effectiveFrom: "2026-03-04",
      target: { comparator: "between", min: 0, max: 55 },
    });
    const h = reports.history(g.id, range);
    expect(h.counts).toEqual({ met: 2, missed: 1, unknown: 2, inProgress: 1 });
    expect(h.days.map((d) => d.outcome)).toEqual([
      "missed",
      "met",
      "unknown",
      "met",
      "unknown",
      "inProgress",
    ]);
    expect(() =>
      reports.update(g.id, { revision: g.revision, effectiveFrom: "2026-03-08", target: null }),
    ).toThrow(/changed/);
    const ended = reports.update(g.id, {
      revision: changed.revision,
      effectiveFrom: "2026-03-07",
      target: null,
    });
    expect(reports.history(g.id, range).days.at(-1)?.day).toBe("2026-03-06");
    db.setTimeZone("UTC"); // New goals see March 9; the existing goal keeps Toronto.
    const g2 = reports.create({
      id: crypto.randomUUID(),
      label: "Study limit",
      metricId: study.id,
      effectiveFrom: "2026-03-08",
      target: { comparator: "atMost", value: 20 },
    });
    const batch = reports.allHistory(range);
    expect(batch.find((h) => h.goal.id === g.id)).toEqual(reports.history(ended.id, range));
    expect(batch.find((h) => h.goal.id === g2.id)?.days.map((d) => [d.day, d.outcome])).toEqual([
      ["2026-03-08", "met"],
      ["2026-03-09", "inProgress"],
    ]);
    plugins[0].enabled = false;
    expect(reports.allHistory(range).map((h) => h.goal.id)).toEqual([g2.id]);
    expect(() => reports.history(g.id, range)).toThrow();
  });
});

it("exposes validated settings, metric and goal routes only within the owning planner", async () => {
  function client() {
    const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
    return (path: string, method = "GET", body?: unknown) =>
      stub.fetch("https://planner.test/api/" + path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
  }
  const a = client(),
    b = client();
  expect(await (await a("report-settings")).json()).toEqual({ timeZone: null });
  expect((await a("report-settings", "PUT", { timeZone: "Mars/Moon" })).status).toBe(400);
  expect(
    await (
      await a("report-settings", "PUT", { timeZone: "America/Toronto", onlyIfUnset: true })
    ).json(),
  ).toEqual({ timeZone: "America/Toronto" });
  expect(
    await (
      await a("report-settings", "PUT", { timeZone: "Europe/Paris", onlyIfUnset: true })
    ).json(),
  ).toEqual({ timeZone: "America/Toronto" });
  expect(await (await b("report-settings")).json()).toEqual({ timeZone: null });
  await a("task-plugins/nutrition", "PUT", { enabled: true });
  const [metric] = metricDefinition.array().parse(await (await a("plugin-metrics")).json());
  expect(metric).toBeDefined();
  const body = {
    id: crypto.randomUUID(),
    metricId: metric.id,
    label: "Daily target",
    effectiveFrom: "2026-01-01",
    target: { comparator: "atLeast", value: 10 },
  };
  const created = goal.parse(await (await a("goals", "POST", body)).json());
  expect(goal.parse(await (await a("goals", "POST", body)).json()).id).toBe(created.id);
  expect((await a("goals", "POST", { ...body, label: "Different" })).status).toBe(409);
  expect(
    (await a("goals", "POST", { ...body, target: { comparator: "between", min: 55, max: 54 } }))
      .status,
  ).toBe(400);
  const history = "goals/" + created.id + "/history?from=2026-01-01&to=2026-01-05";
  expect((await a(history)).status).toBe(200);
  expect((await b(history)).status).toBe(404);
  expect((await a("goals/history?from=2026-01-01&to=2028-01-01")).status).toBe(400);
  expect(
    (await a("plugin-metrics/" + metric.id + "/series?from=2026-01-05&to=2026-01-05")).status,
  ).toBe(400);
  await a("task-plugins/nutrition", "PUT", { enabled: false });
  expect(await (await a("goals")).json()).toEqual([]);
  expect((await a(history)).status).toBe(404);
});
