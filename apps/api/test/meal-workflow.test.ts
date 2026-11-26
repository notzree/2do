import { taskObservationsHeader } from "../src/interfaces/plugin-reports.ts";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { taskDetails } from "../src/interfaces/task-plugins.ts";
import { metricSeries } from "../src/interfaces/plugin-reports.ts";
import { workflowReceipt, type WorkflowCommand } from "../src/interfaces/plugin-workflows.ts";

it("confirms and corrects meals through notebook capture, projects daily goals, and reconciles disabled edits", async () => {
  let planner = env.USER_PLANNER.getByName(crypto.randomUUID());
  const request = (path: string, method = "GET", body?: object) =>
    planner.fetch("https://planner.test/api/" + path, {
      method,
      ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  const ok = async (path: string, method = "GET", body?: object) => {
    const r = await request(path, method, body);
    expect(r.status, path).toBeLessThan(300);
    return r.status === 204 ? undefined : r.json();
  };
  const enable = (enabled: boolean) => ok("task-plugins/nutrition", "PUT", { enabled });
  const get = async (id: string) => taskDetails.parse(await ok("tasks/" + id + "/details"));
  const sub = (id: string) => "tasks/" + id + "/subtypes/nutrition.meal";
  async function actionStatus(id: string, command: WorkflowCommand) {
    const response = await request(sub(id) + "/actions/confirm", "POST", command);
    await response.text();
    return response.status;
  }
  const day = "2026-09-15",
    dayBefore = "2026-09-14";
  const daily = async () =>
    metricSeries.parse(
      await ok("plugin-metrics/nutrition.protein/series?from=" + dayBefore + "&to=2026-09-16"),
    ).buckets;
  async function capture(id: string, title: string) {
    const t = await get(id);
    const completed = await request("tasks/" + id, "PATCH", { revision: t.task.revision, completed: true });
    expect(completed.status).toBe(200);
    expect(completed.headers.get(taskObservationsHeader)).toBe("0");
    await completed.arrayBuffer();
    await ok(sub(id), "PUT", { revision: t.subtypes[0].revision, data: { foods: [title] } });
  }
  async function command(
    id: string,
    input: Record<string, string | number>,
  ): Promise<WorkflowCommand> {
    const [v] = (await get(id)).workflows!;
    return {
      commandId: crypto.randomUUID(),
      taskRevision: v.taskRevision,
      subtypeRevision: v.subtypeRevision,
      workflowRevision: v.workflowRevision,
      installationEpoch: v.installationEpoch,
      input,
    };
  }
  const confirm = (id: string, cmd: WorkflowCommand) =>
    ok(sub(id) + "/actions/confirm", "POST", cmd);
  const patch = async (id: string, fields: object) =>
    ok("tasks/" + id, "PATCH", { revision: (await get(id)).task.revision, ...fields });
  await enable(true);
  await ok("report-settings", "PUT", { timeZone: "America/Toronto" });
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const draft = {
    version: 1,
    revision: 0,
    newTasks: [a, b].map((id) => ({ id, title: "Lunch", typeId: "nutrition.meal" })),
    doc: { type: "doc", content: [a, b].map((id) => ({ type: "taskRef", attrs: { id } })) },
  };
  await ok("days/" + day, "PUT", draft);
  await ok("days/" + day, "PUT", draft);
  expect((await get(a)).workflows?.[0].actions).toEqual([]);
  await capture(a, "Salad");
  await capture(b, "Soup");
  const first = await command(a, { day, proteinGrams: 25, calories: 0 });
  const second = await command(b, { day, proteinGrams: 40 });
  const receipt = workflowReceipt.parse(await confirm(a, first));
  expect(await confirm(a, first)).toEqual(receipt);
  expect(await actionStatus(a, { ...first, input: { day, proteinGrams: 102 } })).toBe(409);
  expect(await actionStatus(a, { ...first, commandId: crypto.randomUUID() })).toBe(409);
  await confirm(b, second);
  expect((await daily()).map((x) => x.value)).toEqual([null, 65]);
  const goalId = crypto.randomUUID();
  await ok("goals", "POST", {
    id: goalId,
    label: "Daily protein",
    metricId: "nutrition.protein",
    effectiveFrom: day,
    target: { comparator: "atLeast", value: 60 },
  });
  const history = async () =>
    await ok("goals/" + goalId + "/history?from=" + day + "&to=2026-09-16");
  expect(await history()).toMatchObject({ counts: { met: 1, missed: 0 } });

  await confirm(b, await command(b, { day, proteinGrams: 30 }));
  expect((await daily())[1].value).toBe(55);
  expect(await history()).toMatchObject({ counts: { met: 0, missed: 1 } });
  // A schedule move changes the plan. A user correction changes the recorded consumption day.
  const moved = await request("tasks/" + b, "PATCH", {
    revision: (await get(b)).task.revision, schedule: { type: "day", date: dayBefore },
  });
  expect(moved.status).toBe(200);
  expect(moved.headers.get(taskObservationsHeader)).toBe("1");
  await moved.arrayBuffer();
  expect((await daily()).map((x) => x.value)).toEqual([null, 55]);
  await confirm(b, await command(b, { day: dayBefore, proteinGrams: 30 }));
  expect((await daily()).map((x) => x.value)).toEqual([30, 25]);
  // Wait for the separate capture classifier to release its alarm before forcing eviction.
  await expect.poll(() => runInDurableObject(planner, (_, ctx) => ctx.storage.getAlarm()), { timeout: 8000 }).toBeNull();
  // Restart from committed storage. workerd graceful eviction can wait for the idle alarm event.
  await expect(runInDurableObject(planner, (_, ctx) => ctx.abort("test planner restart"))).rejects.toThrow();
  planner = env.USER_PLANNER.get(planner.id);

  expect((await daily()).map((x) => x.value)).toEqual([30, 25]);
  const beforeReinstall = await command(b, { day: dayBefore, proteinGrams: 99 });
  await enable(false);
  await patch(a, { completed: false });
  await patch(a, { completed: true });
  await enable(true);
  expect(await actionStatus(b, beforeReinstall)).toBe(409);
  expect((await daily()).map((x) => x.value)).toEqual([30, null]);
  const before = await get(b);
  await ok(sub(b), "PUT", { revision: before.subtypes[0].revision, data: { foods: ["Tofu"] } });
  expect((await daily())[0].value).toBeNull();
  await confirm(b, await command(b, { day: dayBefore, calories: 0 }));
  expect((await daily())[0]).toMatchObject({ value: null, known: 0, unknown: 1 });
  const calories = metricSeries.parse(
    await ok("plugin-metrics/nutrition.calories/series?from=" + dayBefore + "&to=" + day),
  );
  expect(calories.buckets[0]).toMatchObject({ value: 0, known: 1, unknown: 0 });
  await ok(sub(b), "PUT", { revision: (await get(b)).subtypes[0].revision, data: null });
  expect((await daily())[0]).toMatchObject({ value: null, known: 0, unknown: 0 });
  await confirm(a, await command(a, { day, proteinGrams: 25 }));
  await ok("tasks/" + a, "DELETE");
  expect((await daily())[1].value).toBeNull();
  await runInDurableObject(planner, (_, state) => {
    expect(
      state.storage.sql
        .exec("SELECT commandId FROM plugin_command_receipt WHERE taskId=?", a)
        .toArray(),
    ).toEqual([]);
  });
}, 20_000);

it("rolls back captured workflow state when a later reference fails", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  const call = (path: string, body: object) =>
    stub.fetch("https://planner.test/api/" + path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  await call("task-plugins/nutrition", { enabled: true });
  const id = crypto.randomUUID();
  const result = await call("days/2026-11-22", {
    version: 1,
    revision: 0,
    newTasks: [{ id, title: "Lunch", typeId: "nutrition.meal" }],
    doc: {
      type: "doc",
      content: [id, crypto.randomUUID()].map((id) => ({ type: "taskRef", attrs: { id } })),
    },
  });
  expect(result.status).toBe(404);
  await runInDurableObject(stub, (_, s) =>
    expect(
      s.storage.sql.exec("SELECT * FROM plugin_workflow WHERE taskId=?", id).toArray(),
    ).toEqual([]),
  );
});
