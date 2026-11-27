import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it, vi } from "vite-plus/test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { taskDetails } from "../src/interfaces/task-plugins.ts";
import { metricSeries } from "../src/interfaces/plugin-reports.ts";
import { imageReceipt } from "../src/interfaces/images.ts";
import { PlannerImages } from "../src/db/planner-images.ts";
import { mealEstimator } from "../src/plugins/meal-workflow.ts";

const day = "2026-11-12";
const typeId = "nutrition.meal";

async function fixture(mode: "hold" | "fail" | "pass", initialFoods = ["rice", "tofu"]) {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  const id = crypto.randomUUID();
  await runInDurableObject(stub, (_, ctx) => {
    ctx.storage.kv.put("test:meal-effects", true);
    ctx.storage.kv.put("test:no-classifier", true);
    ctx.storage.kv.put("test:estimator", mode);
  });
  await evictDurableObject(stub);
  function request(path: string, method = "GET", body?: object) {
    return new Request("https://planner.test/api/" + path, {
      method,
      ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  }
  async function send(request: Request) {
    const response = await stub.fetch(request);
    await response.text();
    return response.status;
  }
  const taskPath = "tasks/" + id;
  const subtypePath = taskPath + "/subtypes/" + typeId;
  const enable = (enabled: boolean) => send(request("task-plugins/nutrition", "PUT", { enabled }));
  const create = () =>
    send(
      request("tasks", "POST", {
        id,
        title: "Dinner",
        completed: true,
        schedule: { type: "day", date: day },
      }),
    );
  const read = async () =>
    taskDetails.parse(await (await stub.fetch(request(taskPath + "/details"))).json());
  const view = async () => (await read()).workflows![0];
  async function foods(foods: string[]) {
    const revision = (await read()).subtypes.find((s) => s.typeId === typeId)?.revision ?? null;
    expect(await send(request(subtypePath, "PUT", { revision, data: { foods } }))).toBe(200);
  }
  async function command(action: string, input: Record<string, unknown> = {}) {
    const { taskRevision, subtypeRevision, workflowRevision, installationEpoch } = await view();
    return request(subtypePath + "/actions/" + action, "POST", {
      commandId: crypto.randomUUID(),
      installationEpoch,
      taskRevision,
      subtypeRevision,
      workflowRevision,
      input,
    });
  }

  await enable(true);
  expect(await create()).toBe(201);
  await foods(initialFoods);
  const protein = async () =>
    metricSeries.parse(
      await (
        await stub.fetch(
          request("plugin-metrics/nutrition.protein/series?from=" + day + "&to=2026-11-13"),
        )
      ).json(),
    ).buckets[0];
  const stats = () =>
    runInDurableObject(stub, async (_, ctx) => ({
      calls: ctx.storage.kv.get<number>("test:estimate-calls") ?? 0,
      input: ctx.storage.kv.get("test:estimate-input"),
      job: ctx.storage.sql
        .exec<{ due: number; attempts: number }>(
          "SELECT due, attempts FROM plugin_effect WHERE taskId=?",
          id,
        )
        .toArray()[0],
      alarm: await ctx.storage.getAlarm(),
    }));
  const release = () =>
    runInDurableObject(stub, (_, ctx) => {
      ctx.storage.kv.put("test:estimator", "pass");
    });
  const deliverNow = async () => {
    await runInDurableObject(stub, async (_, ctx) => {
      ctx.storage.sql.exec("UPDATE plugin_effect SET due=0 WHERE taskId=?", id);
      await ctx.storage.setAlarm(Date.now() + 600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  };
  // Stage through the real command route. Move its wake into the future before releasing
  // the input gate, so tests of stale responses can await a specific alarm invocation.
  const stage = async () => {
    const req = await command("estimate");
    const url = req.url,
      payload = await req.text();
    await runInDurableObject(stub, (instance, ctx) =>
      ctx.blockConcurrencyWhile(async () => {
        const local = new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
        const response = await instance.fetch(local);
        await response.text();
        expect(response.status).toBe(200);
        const { due } = ctx.storage.sql
          .exec<{ due: number }>("SELECT due FROM plugin_effect WHERE taskId=?", id)
          .one();
        const alarm = await ctx.storage.getAlarm();
        expect(alarm).toBeGreaterThanOrEqual(due);
        expect(alarm).toBeLessThanOrEqual(Date.now() + 1);
        const later = Date.now() + 600_000;
        ctx.storage.sql.exec("UPDATE plugin_effect SET due=? WHERE taskId=?", later, id);
        await ctx.storage.setAlarm(later);
      }),
    );
  };
  return {
    stub,
    view,
    command,
    foods,
    protein,
    stats,
    release,
    stage,
    deliverNow,
    enable,
    create,
    remove: () => stub.fetch(request(taskPath, "DELETE")),
  };
}

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6XkAAAAASUVORK5CYII=";
async function uploadPhoto(planner: ReturnType<typeof env.USER_PLANNER.getByName>) {
  const response = await planner.fetch("https://planner.test/api/images", {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: Uint8Array.from(atob(png), (char) => char.charCodeAt(0)),
  });
  expect(response.status).toBe(201);
  return imageReceipt.parse(await response.json()).id;
}

it("accepts note-only, photo-only and combined context on an empty meal; protects other planners' images", async () => {
  const f = await fixture("pass", []);
  const status = async (action: string, input: Record<string, unknown>) => {
    const response = await f.stub.fetch(await f.command(action, input));
    await response.text();
    return response.status;
  };
  const other = env.USER_PLANNER.getByName(crypto.randomUUID());
  const photo = await uploadPhoto(other);
  const initial = await f.view();
  expect(initial.actions.map((a) => a.id)).toEqual(["estimate"]);
  expect(await status("estimate", {})).toBe(400);
  expect(await status("estimate", { note: "   " })).toBe(400);
  expect(await status("estimate", { note: "x".repeat(2001) })).toBe(400);
  expect(await status("estimate", { photo: "https://example.org/lunch.png" })).toBe(400);
  expect(await status("estimate", { photo })).toBe(404);
  expect(await f.view()).toEqual(initial);
  expect((await f.stats()).calls).toBe(0);

  expect(await uploadPhoto(f.stub)).toBe(photo);
  const note = "Half a bowl of rice with tofu";
  for (const context of [{ note }, { photo }, { photo, note }]) {
    expect(await status("estimate", context)).toBe(200);
    await expect.poll(async () => (await f.view()).pending, { timeout: 8000 }).toBe(false);
    const ready = await f.view();
    expect((await f.stats()).input).toEqual({ foods: [], ...context });
    expect(ready.actions.find((a) => a.id === "estimate")?.defaults).toEqual(context);
    expect(ready.actions.find((a) => a.id === "confirm")?.defaults.proteinGrams).toBe(24);
    expect((await f.protein()).value).toBeNull();
  }
  expect(await status("confirm", { day, proteinGrams: 10 })).toBe(200);
  expect(await status("estimate", { photo, note: "Only ate half" })).toBe(200);
  await expect.poll(async () => (await f.view()).pending, { timeout: 8000 }).toBe(false);
  expect((await f.protein()).value).toBe(10);
  expect(await status("confirm", { day, proteinGrams: 12 })).toBe(200);
  expect((await f.protein()).value).toBe(12);
}, 30_000);

it("sends the uploaded bytes and portion note to the vision model and uses the text path without a photo", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  const photo = await uploadPhoto(stub);
  await runInDurableObject(stub, async (_, ctx) => {
    const images = new PlannerImages(drizzle(ctx.storage), env.NOTEBOOK_IMAGES, ctx.id.toString());
    const run = vi.fn(async () => Response.json({ response: '{"calories":340,"proteinGrams":18}' }));
    const signal = new AbortController().signal;
    const estimate = mealEstimator({ run }, images);
    const note = "Half the portion pictured";
    expect(await estimate({ photo, note }, signal)).toEqual({ calories: 340, proteinGrams: 18 });
    expect(run.mock.calls[0]).toEqual([
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: "system" }),
          {
            role: "user",
            content: [
              { type: "text", text: JSON.stringify({ foods: [], note }) },
              { type: "image_url", image_url: { url: "data:image/png;base64," + png } },
            ],
          },
        ],
      }),
      { returnRawResponse: true, signal },
    ]);
    await estimate({ foods: ["tofu"], note }, signal);
    expect(run.mock.calls[1]).toEqual([
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      expect.objectContaining({
        messages: [
          expect.anything(),
          { role: "user", content: JSON.stringify({ foods: ["tofu"], note }) },
        ],
      }),
      { returnRawResponse: true, signal },
    ]);
    run.mockResolvedValueOnce(Response.json({ response: { proteinGrams: -1 } }));
    await expect(estimate({ note }, signal)).rejects.toThrow();
  });
});

it("delivers estimates without a classifier and counts nutrients only after explicit acceptance", async () => {
  const f = await fixture("hold");
  expect((await f.stub.fetch(await f.command("estimate"))).status).toBe(200);
  try {
    await expect.poll(async () => (await f.stats()).calls, { timeout: 6000 }).toBe(1);
    const current = await f.stats();
    expect(current.input).toEqual({ foods: ["rice", "tofu"] });
    expect(current.job?.attempts).toBe(1);
    expect(current.alarm).toBe(current.job?.due);
    expect(await f.view()).toMatchObject({ pending: true, actions: [{ id: "confirm" }] });
    expect(await f.protein()).toMatchObject({ value: null, known: 0, unknown: 0 });
  } finally {
    await f.release();
  }
  await expect.poll(async () => (await f.view()).pending, { timeout: 8000 }).toBe(false);
  const confirm = (await f.view()).actions.find((a) => a.id === "confirm")!;
  expect(confirm.defaults).toEqual({
    day,
    calories: 408,
    proteinGrams: 24,
    carbohydrateGrams: 45,
    fatGrams: 14,
  });
  expect(await f.protein()).toMatchObject({ value: null, known: 0 });
  expect((await f.stub.fetch(await f.command("confirm", confirm.defaults))).status).toBe(200);
  expect(await f.protein()).toMatchObject({ value: 24, known: 1, unknown: 0 });
  expect(await f.stats()).toMatchObject({ calls: 1, alarm: null });
}, 20_000);

it.each(["foods changed", "plugin reinstalled", "task recreated"] as const)(
  "discards an old estimate after %s",
  async (change) => {
    const f = await fixture("hold");
    await f.stage();
    const delivery = f.deliverNow();
    try {
      await expect.poll(async () => (await f.stats()).calls, { timeout: 8000 }).toBe(1);
      if (change === "foods changed") await f.foods(["beans"]);
      if (change === "plugin reinstalled") {
        await f.enable(false);
        await f.enable(true);
      }
      if (change === "task recreated") {
        expect((await f.remove()).status).toBe(204);
        expect(await f.create()).toBe(201);
        await f.foods(["rice", "tofu"]);
      }
      const ready = await f.view();
      expect(ready).toMatchObject({ pending: false });
      expect(ready.actions.find((a) => a.id === "confirm")?.defaults).toEqual({ day });
      expect(
        (await f.stub.fetch(await f.command("confirm", { day, proteinGrams: 9 }))).status,
      ).toBe(200);
    } finally {
      await f.release();
      await delivery;
    }
    expect((await f.view()).actions.find((a) => a.id === "confirm")?.defaults).toEqual({
      day,
      proteinGrams: 9,
    });
    expect(await f.protein()).toMatchObject({ value: 9, known: 1 });
    expect(await f.stats()).toMatchObject({ calls: 1, alarm: null });
  },
  20_000,
);

it("restores a missing wake after eviction, exhausts a failing estimator and keeps manual entry available", async () => {
  const f = await fixture("fail");
  await f.stage();
  const staged = await f.stats();
  await runInDurableObject(f.stub, async (_, ctx) => {
    await ctx.storage.deleteAlarm();
  });
  await evictDurableObject(f.stub);
  expect(await f.stats()).toMatchObject({ calls: 0, job: staged.job, alarm: staged.job?.due });
  await f.deliverNow();
  const first = await f.stats();
  expect(first.job?.attempts).toBe(1);
  expect(first.alarm).toBe(first.job?.due);
  expect(first.alarm).toBeGreaterThan(Date.now());
  await f.deliverNow();
  const second = await f.stats();
  expect(second.job?.attempts).toBe(2);
  expect(second.alarm).toBe(second.job?.due);
  expect(second.alarm).toBeGreaterThan(Date.now());
  await f.deliverNow();
  expect(await f.stats()).toMatchObject({ calls: 3, alarm: null });
  expect((await f.stats()).job).toBeUndefined();
  expect(await runDurableObjectAlarm(f.stub)).toBe(false);
  const failed = await f.view();
  expect(failed.pending).toBe(false);
  expect(failed.status).toMatch(/unavailable/i);
  expect(failed.actions.map((a) => a.id)).toEqual(["confirm", "estimate"]);
  expect((await f.stub.fetch(await f.command("confirm", { day, proteinGrams: 0 }))).status).toBe(
    200,
  );
  expect(await f.protein()).toMatchObject({ value: 0, known: 1, unknown: 0 });
}, 15000);
