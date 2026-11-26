import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { Temporal } from "@js-temporal/polyfill";
import { expect, it } from "vite-plus/test";
import { plan } from "../src/interfaces/plan.ts";

function fixture() {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  async function call(path: string, method = "GET", body?: object) {
    const response = await stub.fetch("https://test/api/" + path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  }
  return { stub, call };
}

it("creates ordered children once and carries only unfinished tasks across successive days", async () => {
  const { stub, call } = fixture();
  await runInDurableObject(stub, (_, ctx) => {
    ctx.storage.kv.put("test:title-extractor", "pass");
    ctx.storage.kv.put("test:outline", {
      parent: "study",
      body: "411, ece356, capstone",
      children: ["411", "ece356", "capstone"],
    });
  });
  await evictDurableObject(stub);
  const id = crypto.randomUUID(),
    title = "study subtask 411, ece356, capstone";
  const page = {
    version: 1,
    revision: 0,
    doc: { type: "doc", content: [{ type: "taskRef", attrs: { id } }] },
    newTasks: [
      { id, title, rawInput: title, captureDate: "2026-11-24", timeZone: "America/Toronto" },
    ],
  };
  await call("days/2026-11-25", "PUT", page);
  await call("days/2026-11-25", "PUT", page);
  const tasks = plan.parse(await call("tasks")).tasks;
  expect(tasks).toHaveLength(4);
  expect(tasks.find((t) => t.id === id)).toMatchObject({
    title: "study",
    createdDate: "2026-11-24",
    currentDay: "2026-11-25",
  });
  const children = tasks
    .filter((t) => t.parentId === id)
    .sort((a, b) => a.siblingOrder! - b.siblingOrder!);
  expect(children.map((t) => t.title)).toEqual(["411", "ece356", "capstone"]);
  expect(await call("tasks/" + id + "/capture")).toMatchObject({ rawInput: title });
  await call("tasks/" + children[0].id, "PATCH", {
    revision: children[0].revision,
    completed: true,
  });
  await call("tasks", "POST", {
    title: "Event",
    kind: "event",
    schedule: { type: "day", date: "2026-11-25" },
  });
  const move = (date: string) => call("days/" + date + "/carryover", "POST");
  const simultaneous = await Promise.all([move("2026-11-26"), move("2026-11-26")]);
  expect(simultaneous).toEqual(
    expect.arrayContaining([
      { moved: 3, from: "2026-11-25", to: "2026-11-26" },
      { moved: 0, from: "2026-11-25", to: "2026-11-26" },
    ]),
  );
  expect(await move("2026-11-27")).toMatchObject({ moved: 3 });
  expect(await call("tasks/" + id)).toMatchObject({
    createdDate: "2026-11-24",
    currentDay: "2026-11-27",
    carriedFrom: ["2026-11-25", "2026-11-26"],
    schedule: { type: "day", date: "2026-11-27" },
  });
  expect(await call("tasks/" + children[0].id)).toMatchObject({
    currentDay: "2026-11-25",
    completed: true,
  });
});

it("runs a persisted 6 AM alarm, shifts timed work across DST and preserves deadlines", async () => {
  const { stub, call } = fixture(),
    zone = "America/Toronto";
  expect(await call("settings/carryover")).toMatchObject({ enabled: false });
  await call("settings/carryover", "PUT", { enabled: true, timeZone: zone });
  const due = await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm());
  expect(Temporal.Instant.fromEpochMilliseconds(due!).toZonedDateTimeISO(zone).hour).toBe(6);
  const id = crypto.randomUUID();
  await call("tasks", "POST", {
    id,
    title: "Read",
    titleContext: { timeZone: zone },
    schedule: { type: "fixed", start: "2026-03-07T14:00:00Z", end: "2026-03-07T15:00:00Z" },
    due: { type: "day", date: "2026-03-07" },
  });
  await evictDurableObject(stub);
  expect(await call("settings/carryover")).toEqual({ enabled: true, timeZone: zone });
  expect(await call("days/2026-03-08/carryover?timeZone=America%2FToronto", "POST")).toMatchObject({
    moved: 1,
  });
  expect(await call("tasks/" + id)).toMatchObject({
    currentDay: "2026-03-08",
    due: { date: "2026-03-07" },
    schedule: { start: "2026-03-08T13:00:00Z", end: "2026-03-08T14:00:00Z" },
  });

  const localNow = Temporal.Now.zonedDateTimeISO(zone);
  const day = localNow.toPlainDate().subtract({ days: localNow.hour < 6 ? 1 : 0 });
  const previous = day.subtract({ days: 1 }).toString();
  const alarmTask = crypto.randomUUID();
  await call("tasks", "POST", {
    id: alarmTask,
    title: "Read chapter two",
    schedule: { type: "day", date: previous },
  });
  await runInDurableObject(stub, async (_, ctx) => {
    ctx.storage.kv.put("planner:carryover", {
      enabled: true,
      timeZone: zone,
      due: day.toZonedDateTime({ timeZone: zone, plainTime: "06:00" }).epochMilliseconds,
    });
    await ctx.storage.setAlarm(Date.now() + 120_000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await call("tasks/" + alarmTask)).toMatchObject({
    currentDay: day.toString(),
    carriedFrom: [previous],
  });
  const nextAlarm = await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm());
  expect(nextAlarm).toBe(
    day.add({ days: 1 }).toZonedDateTime({ timeZone: zone, plainTime: "06:00" }).epochMilliseconds,
  );
  await call("settings/carryover", "PUT", { enabled: false, timeZone: zone });
  expect(await runDurableObjectAlarm(stub)).toBe(false);
});

it("resolves older notebook tasks and keeps ordinary prose and unrelated days intact", async () => {
  const { stub, call } = fixture();
  const id = crypto.randomUUID();
  const day = "2026-12-31",
    next = "2027-01-01";
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Review notes" }] },
      { type: "taskRef", attrs: { id } },
    ],
  };
  await call("days/" + day, "PUT", {
    version: 1,
    revision: 0,
    doc,
    newTasks: [{ id, title: "Review", rawInput: "Review", captureDate: "2026-12-20" }],
  });
  await runInDurableObject(stub, (_, ctx) => {
    ctx.storage.sql.exec(
      "UPDATE task SET document=json_set(json_remove(document,'$.createdDate','$.currentDay'),'$.schedule',null) WHERE id=?",
      id,
    );
  });
  expect(await call("days/2027-01-02/carryover", "POST")).toMatchObject({ moved: 0 });
  expect(await call("days/" + next + "/carryover", "POST")).toMatchObject({ moved: 1 });
  expect(await call("tasks/" + id)).toMatchObject({
    currentDay: next,
    createdDate: "2026-12-20",
    carriedFrom: [day],
  });
  expect(await call("days/" + day)).toMatchObject({ doc });
});

it("carries an undated child of a completed parent and respects an independently scheduled sibling", async () => {
  const { call } = fixture();
  const parentId = crypto.randomUUID(),
    child = crypto.randomUUID();
  await call("tasks", "POST", {
    id: parentId,
    title: "Project",
    completed: true,
    schedule: { type: "day", date: "2026-12-01" },
  });
  await call("tasks", "POST", { id: child, parentId, title: "Draft" });
  await call("tasks", "POST", {
    parentId,
    title: "Publish",
    schedule: { type: "day", date: "2026-12-10" },
  });
  expect(await call("days/2026-12-02/carryover", "POST")).toMatchObject({ moved: 1 });
  expect(await call("tasks/" + child)).toMatchObject({
    currentDay: "2026-12-02",
    parentId,
    carriedFrom: ["2026-12-01"],
  });
});
