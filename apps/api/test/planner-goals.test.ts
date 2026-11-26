import { drizzle } from "drizzle-orm/durable-sqlite";
import { migratePlanner } from "../src/db/migrate.ts";
import migrations from "../drizzle/migrations.js";
import { budgetingPlugin } from "../src/plugins/budgeting.ts";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { plannerGoal, type GoalChange } from "../src/interfaces/goals.ts";
import { taskDetails } from "../src/interfaces/task-plugins.ts";
import { reportingDay } from "../src/interfaces/plugin-reports.ts";

function fixture() {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  const request = (path: string, method = "GET", body?: object) =>
    stub.fetch("https://test/api/" + path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  async function ok(path: string, method = "GET", body?: object) {
    const r = await request(path, method, body);
    const text = await r.text();
    expect(r.ok, path + " " + text).toBe(true);
    return text ? JSON.parse(text) : undefined;
  }
  const enable = (id: string, enabled = true) => ok("task-plugins/" + id, "PUT", { enabled });
  const goal = async (title: string, typeId?: string, data?: object) =>
    plannerGoal.parse(
      await ok("planner-goals", "POST", {
        id: crypto.randomUUID(),
        title,
        ...(typeId && { subtype: { typeId, version: 1, data } }),
      }),
    );
  const goals = async () => plannerGoal.array().parse(await ok("planner-goals"));
  const details = async (id: string) => taskDetails.parse(await ok("tasks/" + id + "/details"));
  const change = async (id: string, revision: string, change: GoalChange) =>
    plannerGoal.parse(await ok("planner-goals/" + id, "PATCH", { revision, change }));
  let pageRevision = 0;
  let timingEnabled = false;
  const refs: string[] = [];
  async function capture(typeId: string, title: string, timing?: Record<string, string | number>) {
    if (timing) {
      await runInDurableObject(stub, (_, ctx) =>
        ctx.storage.kv.put("test:task-time", { [title]: timing }),
      );
      if (!timingEnabled) {
        await evictDurableObject(stub);
        timingEnabled = true;
      }
    }
    const id = crypto.randomUUID();
    refs.push(id);
    await ok("days/2026-11-25", "PUT", {
      version: 1,
      revision: pageRevision++,
      doc: { type: "doc", content: refs.map((id) => ({ type: "taskRef", attrs: { id } })) },
      newTasks: [
        {
          id,
          title,
          rawInput: title,
          typeId,
          timeZone: "America/Toronto",
          captureDate: "2026-11-25",
        },
      ],
    });
    return details(id);
  }
  async function log(id: string, typeId: string, action: string, input: object) {
    const wf = (await details(id)).workflows!.find((w) => w.typeId === typeId)!;
    const body = {
      commandId: crypto.randomUUID(),
      taskRevision: wf.taskRevision,
      subtypeRevision: wf.subtypeRevision,
      installationEpoch: wf.installationEpoch,
      workflowRevision: wf.workflowRevision,
      input,
    };
    const path = "tasks/" + id + "/subtypes/" + typeId + "/actions/" + action;
    expect(await ok(path, "POST", body)).toEqual(await ok(path, "POST", body));
  }
  return { stub, ok, goal, goals, enable, change, details, request, capture, log };
}

it("captures plain goals atomically and distinguishes contributions, milestones and check-ins", async () => {
  const f = fixture(),
    id = crypto.randomUUID(),
    title = "Feel ready for interviews";
  const body = {
    version: 1,
    revision: 0,
    doc: { type: "doc", content: [{ type: "goalRef", attrs: { id } }] },
    newTasks: [],
    newGoals: [{ id, title }],
  };
  await f.ok("days/2026-11-25", "PUT", body);
  await f.ok("days/2026-11-25", "PUT", body);
  let [g] = await f.goals();
  expect(g.title).toBe(title);
  const t = await f.ok("tasks", "POST", { title: "Practice networking questions" });
  g = await f.change(id, g.revision, { action: "link", taskId: t.id, role: "contributes" });
  await f.ok("tasks/" + t.id, "PATCH", { revision: t.revision, completed: true });
  const other = await f.goal("Prepare for onsite");
  await f.change(other.id, other.revision, { action: "link", taskId: t.id, role: "satisfies" });
  expect((await f.goals()).find((x) => x.id === id)).toMatchObject({
    achieved: false,
    links: [{ completed: true }],
  });
  expect((await f.goals()).find((x) => x.id === other.id)?.achieved).toBe(true);
  const revision = g.revision;
  g = await f.change(id, revision, {
    action: "check-in",
    note: "Still shaky on concurrency",
    nextCheckIn: "2026-12-01",
  });
  expect(g).toMatchObject({
    nextCheckIn: "2026-12-01",
    checkIns: [{ note: "Still shaky on concurrency" }],
  });
  expect(
    (
      await f.request("planner-goals/" + id, "PATCH", {
        revision,
        change: { action: "achievement", achieved: true },
      })
    ).status,
  ).toBe(409);
  expect((await f.change(id, g.revision, { action: "achievement", achieved: true })).achieved).toBe(
    true,
  );
  await f.ok("tasks/" + t.id, "DELETE");
  expect((await f.goals()).find((x) => x.id === other.id)).toMatchObject({
    achieved: false,
    links: [],
  });
});
it("preserves metric target IDs and history alongside core goals", async () => {
  const f = fixture();
  await f.enable("nutrition");
  const input = {
    id: crypto.randomUUID(),
    label: "Protein",
    metricId: "nutrition.protein",
    target: { comparator: "atLeast", value: 60 },
    effectiveFrom: "2026-11-01",
  };
  const daily = await f.ok("goals", "POST", input);
  let [g] = await f.goals();
  expect(g).toMatchObject({ id: daily.id, dailyMetric: input.metricId });
  g = await f.change(g.id, g.revision, {
    action: "edit",
    title: "Protein intake",
    targetDate: null,
    nextCheckIn: null,
  });
  const h = await f.ok("goals/" + g.id + "/history?from=2026-11-01&to=2026-11-03");
  expect(h.goal).toMatchObject({ id: g.id, label: g.title, versions: [{ target: input.target }] });
  await f.enable("nutrition", false);
  expect(await f.goals()).toHaveLength(1);
  expect(await f.ok("goals")).toEqual([]);
});
it("keeps planned and actual activity separate and evaluates performance on one run", async () => {
  const f = fixture();
  await f.enable("fitness");
  const weekly = await f.goal("Three activities", "fitness.weekly-activity", { count: 3 });
  const target = await f.goal("Run 5 km in 25", "fitness.run-performance", { km: 5, minutes: 25 });
  const day = reportingDay("UTC");
  const a = await f.capture("fitness.activity", "Run 5 km tomorrow at 7am for 30 minutes", {
    scheduled_date: "2026-11-26",
    scheduled_date_phrase: "tomorrow",
    start_time: "07:00:00",
    duration_seconds: 1800,
  });
  expect(a).toMatchObject({
    task: { durationMinutes: 30, schedule: { type: "fixed" } },
    subtypes: [{ data: { distanceKm: 5, activityKind: "cardio" } }],
  });
  const b = await f.capture("fitness.activity", "Run 4 km");
  await f.log(a.task.id, "fitness.activity", "log", {
    day,
    activity: "running",
    minutes: 30,
    km: 5,
  });
  await f.log(b.task.id, "fitness.activity", "log", { day, activity: "run", minutes: 24, km: 4 });
  expect((await f.goals()).find((g) => g.id === target.id)?.achieved).toBe(false);
  expect((await f.goals()).find((g) => g.id === weekly.id)?.progress?.label).toContain("2 of 3");
  await f.log(a.task.id, "fitness.activity", "log", {
    day,
    activity: "running",
    minutes: 24,
    km: 5,
  });
  expect((await f.goals()).find((g) => g.id === target.id)?.achieved).toBe(true);
  await f.enable("fitness", false);
  expect((await f.goals()).find((g) => g.id === target.id)?.progress).toBeNull();
  await f.enable("fitness");
  expect((await f.goals()).find((g) => g.id === target.id)?.achieved).toBe(true);
});
it("replaces corrected payments and respects currency and month boundaries", async () => {
  const f = fixture();
  await f.enable("budgeting");
  await f.goal("Monthly limit", "budgeting.monthly-limit", {
    month: "2026-09",
    currency: "CAD",
    limit: 300,
  });
  const e = await f.capture("budgeting.expense", "Buy groceries for CAD 75");
  expect(e.subtypes[0].data).toMatchObject({ amount: 75, currency: "CAD" });
  const balance = async () => (await f.goals())[0].progress!.label;
  expect(await balance()).toContain("300.00 remaining");
  const pay = (amount: number, day: string, currency = "CAD") =>
    f.log(e.task.id, "budgeting.expense", "pay", { day, amount, currency });
  await pay(62.4, "2026-09-08");
  expect(await balance()).toContain("237.60 remaining");
  await pay(60, "2026-09-08");
  expect(await balance()).toContain("240.00 remaining");
  await pay(60, "2026-09-08", "USD");
  expect(await balance()).toContain("300.00 remaining");
  await pay(60, "2026-10-01");
  expect(await balance()).toContain("No payments logged");
});
it("preserves a deliverable deadline independently of scheduled and actual work", async () => {
  const f = fixture();
  await f.enable("productivity");
  const d = await f.capture("productivity.deadline", "Submit the proposal Friday", {
    due_date: "2026-11-27",
  });
  expect(d.task).toMatchObject({ due: { type: "day", date: "2026-11-27" }, schedule: null });
  const s = await f.capture(
    "productivity.work-session",
    "Draft proposal Thursday 2–3pm, due Friday 5pm",
    {
      scheduled_date: "2026-11-26",
      scheduled_date_phrase: "Thursday",
      start_time: "14:00:00",
      end_time: "15:00:00",
      end_time_phrase: "3pm",
      due_date: "2026-11-27",
      due_time: "17:00:00",
      due_time_phrase: "5pm",
      deadline_phrase: "due Friday 5pm",
    },
  );
  expect(s.task).toMatchObject({
    due: { type: "time", at: "2026-11-27T22:00:00.000Z" },
    durationMinutes: 60,
    schedule: { type: "fixed", start: "2026-11-26T19:00:00.000Z" },
  });
  await f.ok("tasks/" + s.task.id, "PATCH", {
    revision: s.task.revision,
    schedule: { type: "day", date: "2026-11-25" },
  });
  expect((await f.details(s.task.id)).task.due).toEqual(s.task.due);
  const day = reportingDay("UTC");
  await f.goal("Weekly focus", "productivity.weekly-work", { count: 3 });
  await f.log(s.task.id, "productivity.work-session", "log", { day, minutes: 40 });
  expect((await f.goals())[0].progress?.label).toContain("1 of 3");
});

it.each([
  ["Paid 1,250 CAD for rent", "CAD", 1250],
  ["EUR 18,50", "EUR", 18.5],
  ["Groceries 1.250,50 EUR", "EUR", 1250.5],
  ["Paid CAD 1,250.50", "CAD", 1250.5],
  ["Paid 1\u202f250,50 €", "EUR", 1250.5],
  ["Paid $18.50 CAD", "CAD", 18.5],
] as const)("prefills and posts the full amount in %s", async (title, currency, amount) => {
  const f = fixture();
  await f.enable("budgeting");
  const expense = await f.capture("budgeting.expense", title);
  const defaults = expense.workflows![0].actions.find((a) => a.id === "pay")!.defaults;
  expect(defaults).toMatchObject({ amount, currency });
  await f.log(expense.task.id, "budgeting.expense", "pay", { ...defaults, day: "2026-11-25" });
  const report = await f.ok(
    "plugin-metrics/budgeting.spend-" +
      currency.toLowerCase() +
      "/series?from=2026-11-25&to=2026-11-26",
  );
  expect(report.buckets[0]).toMatchObject({ value: amount, known: 1 });
});

it.each([
  ["fitness.activity", "log", { activity: "running", km: 5, minutes: 24 }, "fitness.minutes", 24],
  ["budgeting.expense", "pay", { currency: "CAD", amount: 1250 }, "budgeting.spend-cad", 1250],
  ["productivity.work-session", "log", { minutes: 40 }, "productivity.minutes", 40],
] as const)(
  "retains a confirmed automatic %s log through rename and reclassification",
  async (type, action, fields, metric, value) => {
    const f = fixture(),
      day = "2026-11-25";
    await f.enable(type.split(".")[0]);
    const winner = (id: string) =>
      runInDurableObject(f.stub, (_, ctx) => {
        ctx.storage.kv.put("test:winning-subtype", id);
      });
    const settle = () =>
      runInDurableObject(f.stub, async (planner, ctx) => {
        ctx.storage.sql.exec("UPDATE task_classification SET due = 0 WHERE attempts = 0");
        await planner.alarm!();
      });
    await winner(type);
    const task = await f.ok("tasks", "POST", { title: "First title" });
    await settle();
    expect((await f.details(task.id)).subtypes[0].source).toBe("automatic");
    await f.log(task.id, type, action, { day, ...fields });
    const check = async () => {
      const details = await f.details(task.id);
      expect(details.subtypes).toMatchObject([{ source: "manual", typeId: type }]);
      expect(details.workflows![0].actions.find((a) => a.id === action)?.defaults).toMatchObject({
        day,
        ...fields,
      });
      const series = await f.ok(
        "plugin-metrics/" + metric + "/series?from=" + day + "&to=2026-11-26",
      );
      expect(series.buckets[0]).toMatchObject({ known: 1, value });
    };
    for (const [title, prediction] of [
      ["New title, same match", type],
      ["Generic title", "none"],
    ]) {
      await winner(prediction);
      await f.ok("tasks/" + task.id, "PATCH", {
        revision: (await f.details(task.id)).task.revision,
        title,
      });
      await check();
      await settle();
      expect((await f.details(task.id)).lastClassification?.matched).toEqual(
        prediction === type ? [type] : [],
      );
      await check();
    }
  },
);

it("abstains on malformed, conflicting, or multiple payment amounts", () => {
  const extract = budgetingPlugin.subtypes[0].fromTitle!;
  for (const title of [
    "Paid 1,25,0 CAD",
    "EUR 18.5.0",
    "Paid EUR 18,50 CAD",
    "USD 18 and USD 50",
    "Paid -1,250 CAD",
    "EUR 12e3",
    "GBP 12-15",
    "JPY 18,50",
  ]) {
    expect(extract(title), title).toEqual({});
  }
});

it("protects pre-upgrade confirmed logs and leaves an unconfirmed suggestion title-bound", async () => {
  const f = fixture(),
    type = "budgeting.expense",
    day = "2026-11-25";
  await f.enable("budgeting");
  const logged = await f.capture(type, "EUR 18,50 for supplies"),
    draft = await f.capture(type, "CAD 1,250 for rent");
  await f.log(logged.task.id, type, "pay", { day, currency: "EUR", amount: 18.5 });
  await runInDurableObject(f.stub, async (_, ctx) => {
    const sql = ctx.storage.sql;
    for (const { task } of [logged, draft]) {
      sql.exec(
        "UPDATE task_subtype SET source='automatic', schemaVersion=1, classifiedTitle=? WHERE taskId=? AND typeId=?",
        task.title,
        task.id,
        type,
      );
    }
    const step = migrations.journal.entries.find((e) => e.tag.endsWith("preserve_confirmed_logs"))!;
    sql.exec("DELETE FROM __drizzle_migrations WHERE created_at >= ?", step.when);
    await migratePlanner(drizzle(ctx.storage));
    await migratePlanner(drizzle(ctx.storage));
  });
  await evictDurableObject(f.stub); // Run registered subtype upgrades after the SQL migration.
  expect((await f.details(draft.task.id)).subtypes[0].source).toBe("automatic");
  await f.ok("tasks/" + logged.task.id, "PATCH", {
    title: "Updated title",
    revision: logged.task.revision,
  });
  const checked = await f.details(logged.task.id);
  expect(checked.subtypes[0].source).toBe("manual");
  expect(checked.workflows![0].actions[0].defaults).toMatchObject({
    day,
    currency: "EUR",
    amount: 18.5,
  });
  expect(
    (await f.ok("plugin-metrics/budgeting.spend-eur/series?from=" + day + "&to=2026-11-26"))
      .buckets[0],
  ).toMatchObject({ value: 18.5, known: 1 });
});

it.each(["-", "–", "—", "−", " to ", "/"])(
  "leaves prefix and suffix price ranges blank (%s)",
  async (separator) => {
    const f = fixture();
    await f.enable("budgeting");
    for (const title of [`15${separator}20 CAD`, `CAD 15${separator}20`]) {
      const expense = await f.capture("budgeting.expense", title);
      expect(expense.subtypes[0].data).not.toHaveProperty("amount");
      expect(expense.workflows![0].actions[0].defaults).not.toHaveProperty("amount");
    }
  },
);

it("keeps the legacy amount out of defaults after renaming and reopening the planner", async () => {
  const f = fixture();
  await f.enable("budgeting");
  const type = "budgeting.expense";
  const expense = await f.capture(type, "Paid 1,250 CAD for rent");
  const edited = await f.capture(type, "Paid 1,250 CAD for rent");
  const share = await f.capture(type, "Paid 1,250 CAD for rent");
  await f.ok("tasks/" + share.task.id, "PATCH", {
    title: "My rent share: CAD 250",
    revision: share.task.revision,
  });
  // Seed records as the v1 extractor stored them. One task already lost the price in its display title.
  await f.ok("tasks/" + expense.task.id, "PATCH", {
    title: "November rent",
    revision: expense.task.revision,
  });
  await runInDurableObject(f.stub, (_, ctx) => {
    for (const [id, amount] of [
      [expense.task.id, 250],
      [edited.task.id, 1200],
      [share.task.id, 250],
    ] as const)
      ctx.storage.sql.exec(
        "UPDATE task_subtype SET schemaVersion=1, document=json_set(document,'$.amount',?) WHERE taskId=? AND typeId=?",
        amount,
        id,
        type,
      );
  });
  await evictDurableObject(f.stub);
  const repaired = await f.details(expense.task.id);
  expect(repaired.subtypes[0]).toMatchObject({ schemaVersion: 2, data: { currency: "CAD" } });
  expect(repaired.subtypes[0].data).not.toHaveProperty("amount");
  expect(repaired.workflows![0].actions[0].defaults).not.toHaveProperty("amount");
  await f.ok("tasks/" + expense.task.id, "PATCH", {
    title: "December rent",
    revision: repaired.task.revision,
  });
  await evictDurableObject(f.stub);
  expect((await f.details(expense.task.id)).workflows![0].actions[0].defaults).not.toHaveProperty(
    "amount",
  );
  expect((await f.details(share.task.id)).workflows![0].actions[0].defaults.amount).toBe(250);
  expect((await f.details(edited.task.id)).workflows![0].actions[0].defaults.amount).toBe(1200);
});

it("repairs a v1 partial amount before rename and accepts an explicit price edit afterward", async () => {
  const f = fixture();
  await f.enable("budgeting");
  const expense = await f.capture("budgeting.expense", "Paid 1,250 CAD for rent");
  await runInDurableObject(f.stub, (_, ctx) => {
    ctx.storage.sql.exec(
      "UPDATE task_subtype SET schemaVersion=1, document=json_set(document,'$.amount',250) WHERE taskId=?",
      expense.task.id,
    );
  });
  await evictDurableObject(f.stub);
  const before = await f.details(expense.task.id);
  expect(before.workflows![0].actions[0].defaults).not.toHaveProperty("amount");
  await f.ok("tasks/" + expense.task.id, "PATCH", {
    title: "November rent",
    revision: before.task.revision,
  });
  expect((await f.details(expense.task.id)).workflows![0].actions[0].defaults).not.toHaveProperty(
    "amount",
  );
  await f.ok("tasks/" + expense.task.id + "/subtypes/budgeting.expense", "PUT", {
    revision: before.subtypes[0].revision,
    data: { currency: "CAD", amount: 250 },
  });
  expect((await f.details(expense.task.id)).workflows![0].actions[0].defaults.amount).toBe(250);
});
