import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vite-plus/test";
import { Planner } from "../src/core/planner.ts";
import { SubtypeExtraction } from "../src/core/subtype-extraction.ts";
import { TaskPlugins } from "../src/core/task-plugins.ts";
import { SqlitePlannerDatabase } from "../src/db/planner.ts";
import { ExtractionQueue } from "../src/db/subtype-extraction.ts";
import { SqliteTaskPluginDatabase } from "../src/db/task-plugins.ts";
import { clairicExtractor } from "../src/extractors/clairic.ts";
import { extractTaskTime } from "../src/extractors/task-time.ts";
import type { CommitTaskWrite } from "../src/interfaces/database.ts";
import { createTask } from "../src/interfaces/plan.ts";
import { taskDetails } from "../src/interfaces/task-plugins.ts";
import { nutritionPlugin, mealType } from "../src/plugins/meal.ts";

const context = {
  timeZone: "America/Toronto",
  defaultDate: "2026-12-04",
  referenceDate: "2026-11-25",
};

it("uses Clairic typed values and anchors a clock to the selected day", async () => {
  const extract = clairicExtractor({
    async run(model: string, input: unknown, options?: AiOptions) {
      expect(model).toBe("@cf/cloudflare/clairic");
      expect(options?.returnRawResponse).toBe(true);
      expect(input).toMatchObject({
        state: expect.stringContaining("Task title: Run 400m at 7am"),
        reference_date: context.referenceDate,
        fields: {
          scheduled_date: { type: "date" },
          start_time: { type: "time" },
          duration_seconds: { type: "duration" },
        },
      });
      return Response.json({
        answers: {
          scheduled_date: { value: null },
          scheduled_date_phrase: { value: null },
          start_time: { value: "07:00:00" },
          end_time: { value: null },
          end_time_phrase: { value: null },
          scheduled_time_zone: { value: null },
          ambiguous_schedule: { value: false },
          due_date: { value: null },
          deadline_phrase: { value: null },
          due_time: { value: null },
          due_time_phrase: { value: null },
          due_time_zone: { value: null },
          duration_seconds: { value: null },
        },
      });
    },
  });
  expect(await extractTaskTime(extract, "Run 400m at 7am", context)).toEqual({
    schedule: { type: "fixed", start: "2026-12-04T12:00:00.000Z", end: "2026-12-04T13:00:00.000Z" },
  });
  expect(await extractTaskTime(undefined, "Dinner tomorrow at 7pm", context)).toEqual({});
});

it("rejects ambiguous or nonexistent local times and handles overnight intervals", async () => {
  for (const [day, clock] of [
    ["2026-03-08", "02:30:00"],
    ["2026-11-01", "01:30:00"],
  ]) {
    expect(
      await extractTaskTime(
        async () => ({ scheduled_date: day, scheduled_date_phrase: day, start_time: clock }),
        day,
        context,
      ),
    ).toEqual({});
  }
  expect(
    await extractTaskTime(
      async () => ({ start_time: "23:00:00", end_time: "01:00:00", end_time_phrase: "1am" }),
      "Study 11pm–1am",
      context,
    ),
  ).toMatchObject({ durationMinutes: 120 });
  expect(
    await extractTaskTime(
      async () => ({ start_time: "19:00:00", ambiguous_schedule: true }),
      "Call at 7pm or 9pm",
      context,
    ),
  ).toEqual({});
  expect(
    await extractTaskTime(
      async () => ({ start_time: "09:00:00", scheduled_time_zone: "PST" }),
      "Meet at 9am PST",
      context,
    ),
  ).toMatchObject({ schedule: { start: "2026-12-04T17:00:00.000Z" } });
});

async function client(extractor?: "pass" | "hold", when = "at 7pm") {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  const call = async (path: string, method = "GET", body?: object) => {
    const response = await stub.fetch("https://test/api/" + path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.ok, path).toBe(true);
    return response.json();
  };
  const id = crypto.randomUUID();
  const title = "Get dinner at Nuri Village";
  const rawInput = title + " " + when + " for 45 minutes: salmon and rice";
  await runInDurableObject(stub, (_, ctx) => {
    if (extractor) ctx.storage.kv.put("test:title-extractor", extractor);
    ctx.storage.kv.put("test:task-time", {
      [rawInput]: {
        start_time: "19:00:00",
        duration_seconds: 2700,
        ...(when.startsWith("tomorrow") && {
          scheduled_date: "2026-11-26",
          scheduled_date_phrase: "tomorrow",
        }),
      },
      "Run 400m at 7am": { start_time: "07:00:00", duration_seconds: 2700 },
      "Meet at 9am": { start_time: "09:00:00" },
    });
  });
  await evictDurableObject(stub);
  const capture = (typeId?: string) =>
    call("days/" + context.defaultDate, "PUT", {
      version: 1,
      revision: 0,
      doc: { type: "doc", content: [{ type: "taskRef", attrs: { id } }] },
      newTasks: [
        {
          id,
          title,
          rawInput,
          typeId,
          captureDate: context.referenceDate,
          timeZone: context.timeZone,
        },
      ],
    });
  const details = async () => taskDetails.parse(await call("tasks/" + id + "/details"));
  return { stub, call, id, capture, details, rawInput };
}

it("extracts task fields with all plugins disabled and preserves explicit edits", async () => {
  const f = await client();
  await f.capture();
  const { task, subtypes } = await f.details();
  expect(task).toMatchObject({
    durationMinutes: 45,
    schedule: { start: "2026-12-05T00:00:00.000Z" },
  });
  expect(subtypes).toEqual([]);
  await f.call("tasks/" + f.id, "PATCH", {
    revision: task.revision,
    title: "Meet at 9am",
    durationMinutes: 20,
  });
  expect((await f.details()).task).toMatchObject({ schedule: task.schedule, durationMinutes: 20 });
});

it("keeps explicitly null API fields even when Clairic supplies values", async () => {
  const f = await client();
  const task = await f.call("tasks", "POST", {
    title: "Run 400m at 7am",
    schedule: null,
    durationMinutes: null,
    titleContext: context,
  });
  expect(task).toMatchObject({ schedule: null, durationMinutes: null });
});

it.each([true, false])(
  "saves task time on capture and fills Meal foods afterward (explicit %s)",
  async (explicit) => {
    const f = await client("pass", "tomorrow at 7pm");
    await f.call("task-plugins/nutrition", "PUT", { enabled: true });
    await f.capture(explicit ? "nutrition.meal" : undefined);
    const expectedTime = {
      durationMinutes: 45,
      schedule: {
        type: "fixed",
        start: "2026-11-27T00:00:00.000Z",
        end: "2026-11-27T00:45:00.000Z",
      },
    };
    expect((await f.details()).task).toMatchObject(expectedTime);
    await expect
      .poll(async () => (await f.details()).subtypes[0]?.data, { timeout: 10000 })
      .toEqual({ foods: ["salmon", "rice"] });
    await expect
      .poll(async () => (await f.details()).lastClassification, { timeout: 10000 })
      .toMatchObject({ evaluated: ["nutrition.meal"], matched: ["nutrition.meal"] });
    expect(await f.details()).toMatchObject({
      task: expectedTime,
      subtypes: [
        { source: explicit ? "manual" : "automatic", data: { foods: ["salmon", "rice"] } },
      ],
    });
    expect(
      await runInDurableObject(f.stub, (_, ctx) => ctx.storage.kv.get("test:extraction-input")),
    ).toMatchObject({
      title: f.rawInput,
      fields: [{ path: "foods" }],
    });
    expect(await f.call("tasks/summaries", "POST", { ids: [f.id] })).toMatchObject([
      { inlays: [{ field: "foods", value: "salmon, rice" }] },
    ]);
  },
  15000,
);

it("discards an extraction if the user edits the subtype during inference", async () => {
  const f = await client("hold");
  await f.call("task-plugins/nutrition", "PUT", { enabled: true });
  await f.capture("nutrition.meal");
  try {
    await expect
      .poll(
        () => runInDurableObject(f.stub, (_, ctx) => !!ctx.storage.kv.get("test:extraction-input")),
        { timeout: 10000 },
      )
      .toBe(true);
    const details = await f.details();
    expect(details.extracting).toBe(true);
    await f.call("tasks/" + f.id + "/subtypes/nutrition.meal", "PUT", {
      revision: details.subtypes[0].revision,
      data: { foods: ["soup"] },
    });
  } finally {
    await runInDurableObject(f.stub, (_, ctx) => {
      ctx.storage.kv.put("test:title-extractor", "pass");
    });
  }
  await expect.poll(async () => (await f.details()).extracting, { timeout: 10000 }).toBeUndefined();
  expect((await f.details()).subtypes[0].data).toEqual({ foods: ["soup"] });
}, 15000);

it("processes a bounded batch of subtype field jobs and retries a failed job independently", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_, { storage }) => {
    const store = drizzle(storage);
    const db = new SqlitePlannerDatabase(store);
    const plugins = new TaskPlugins(db, new SqliteTaskPluginDatabase(store), [nutritionPlugin]);
    const planner = new Planner(db);
    const queue = new ExtractionQueue(store);
    const commit: CommitTaskWrite = async (write) => db.transaction(write);
    const release = Promise.withResolvers<void>();
    const started: string[] = [];
    let fail = true;
    let firstTitle: string | undefined;
    const extraction = new SubtypeExtraction(queue, db, plugins, async (title) => {
      started.push(title);
      firstTitle ??= title;
      await release.promise;
      if (fail && title === firstTitle) throw new Error("Temporary extractor failure");
      return { foods: ["soup"] };
    });
    plugins.setEnabled("nutrition", true);
    const tasks = Array.from({ length: 6 }, (_, i) => {
      const task = planner.create(createTask.parse({ title: "Lunch " + i }));
      const record = plugins.attachAtCapture(task.id, mealType.id);
      extraction.enqueue(task, mealType, record, task.title);
      return task;
    });

    const batch = extraction.processDue(commit);
    try {
      await expect.poll(() => started.length, { timeout: 1000 }).toBe(4);
    } finally {
      release.resolve();
      await batch;
    }
    const details = () => tasks.map((task) => plugins.details(task.id));
    expect(details().filter((d) => d.subtypes[0].data?.foods).length).toBe(3);
    const failed = tasks.find((task) => task.title === firstTitle)!;
    expect(plugins.details(failed.id)).toMatchObject({
      extracting: true,
      subtypes: [{ source: "manual", data: {} }],
    });

    fail = false;
    storage.sql.exec("UPDATE subtype_extraction SET due = 0 WHERE taskId = ?", failed.id);
    await extraction.processDue(commit);
    expect(started.filter((title) => title === firstTitle)).toHaveLength(2);
    expect(details().every((d) => !d.extracting && !!d.subtypes[0].data?.foods)).toBe(true);
    expect(queue.nextDue()).toBeNull();
  });
});
