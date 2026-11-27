import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it, vi } from "vite-plus/test";
import webpush from "web-push";
import { PlannerReminders, afterQuiet } from "../src/core/reminders.ts";
import { sendReminderPush } from "../src/core/reminder-push.ts";
import { SqlitePlannerDatabase } from "../src/db/planner.ts";
import { Planner } from "../src/core/planner.ts";
import { createTask } from "../src/interfaces/plan.ts";
import { reminderSubscription } from "../src/interfaces/reminders.ts";

it("recomputes a task reminder, publishes it once, and cancels a snooze when the task completes", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_, ctx) => {
    const db = new SqlitePlannerDatabase(drizzle(ctx.storage));
    const published: string[] = [];
    const reminders = new PlannerReminders(
      ctx.storage,
      db,
      (notice) => published.push(notice.id),
      {},
      "scope",
    );
    reminders.migrate();
    const planner = new Planner(db, (task) => reminders.taskChanged(task));
    const start = Date.parse("2032-05-20T14:00:00Z");
    const schedule = (at: number) => ({
      type: "fixed" as const,
      start: new Date(at).toISOString(),
      end: new Date(at + 3600000).toISOString(),
    });
    let task = planner.create(createTask.parse({ title: "Lab", schedule: schedule(start) }));
    const rule = crypto.randomUUID();
    reminders.set(rule, {
      taskId: task.id,
      title: "Upcoming class",
      enabled: true,
      trigger: { kind: "before", anchor: "start", minutes: 15 },
    });
    const commit = async <T>(f: () => T) => ctx.storage.transactionSync(f);
    const first = start - 900000;
    expect(reminders.nextDue()).toBe(first);
    task = planner.update(task.id, {
      revision: task.revision,
      schedule: schedule(start + 7200000),
    });
    await reminders.processDue(commit, first);
    expect(published).toEqual([]);
    const second = first + 7200000;
    await reminders.processDue(commit, second);
    await reminders.processDue(commit, second);
    expect(published).toHaveLength(1);
    task = planner.update(task.id, { revision: task.revision, title: "Lab renamed" });
    await reminders.processDue(commit, second + 1);
    expect(published).toHaveLength(1);
    const notice = published[0];
    expect(reminders.act(rule, notice, 10, second)).toEqual({ id: notice });
    reminders.act(rule, notice, 10, second + 1);
    expect(reminders.nextDue()).toBe(second + 600000);
    planner.update(task.id, { revision: task.revision, completed: true });
    await reminders.processDue(commit, second + 600000);
    expect(published).toEqual([notice]);
    expect(reminders.nextDue()).toBe(null);
  });
});

it("backfills a due rule in bounded batches and skips stale occurrences", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_, ctx) => {
    const db = new SqlitePlannerDatabase(drizzle(ctx.storage));
    const published: string[] = [];
    const reminders = new PlannerReminders(
      ctx.storage,
      db,
      (n) => published.push(n.id),
      {},
      "scope",
    );
    reminders.migrate();
    const planner = new Planner(db);
    const now = Date.parse("2032-05-20T10:00:00Z");
    for (let i = 0; i < 33; i++)
      planner.create(
        createTask.parse({
          title: "Task " + i,
          due: {
            type: "time",
            at: new Date(i === 0 ? now - 86400000 : now + 900000).toISOString(),
            timeZone: "UTC",
          },
        }),
      );
    reminders.set(
      crypto.randomUUID(),
      { title: "Deadline", enabled: true, trigger: { kind: "due-tasks", minutes: 15 } },
      now,
    );
    const commit = async <T>(f: () => T) => ctx.storage.transactionSync(f);
    await reminders.processDue(commit, now);
    expect(reminders.nextDue()).toBeLessThanOrEqual(now);
    await reminders.processDue(commit, now);
    expect(published).toHaveLength(32);
    expect(reminders.nextDue()).toBe(null);
  });
});

it("defers overnight quiet hours through the spring DST change", () => {
  expect(
    new Date(
      afterQuiet(Date.parse("2027-03-14T04:30:00Z"), {
        paused: false,
        timeZone: "America/Toronto",
        dayTime: "09:00",
        quietStart: "22:00",
        quietEnd: "08:00",
      }),
    ).toISOString(),
  ).toBe("2027-03-14T12:00:00.000Z");
});

it("constructs encrypted, signed Web Push requests using the Worker runtime", async () => {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  const ua = webpush.generateVAPIDKeys();
  const sub = reminderSubscription.parse({
    endpoint: "https://fcm.googleapis.com/fcm/send/fixture",
    keys: {
      p256dh: ua.publicKey,
      auth: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  });
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 201 }));
  try {
    const id = crypto.randomUUID();
    const status = await sendReminderPush(
      {
        WEB_PUSH_PUBLIC_KEY: publicKey,
        WEB_PUSH_PRIVATE_KEY: privateKey,
        WEB_PUSH_SUBJECT: "mailto:test@example.com",
      },
      sub,
      { id, title: "Reminder", body: "Private content" },
      Date.now() + 10000,
      "scope",
    );
    expect(status).toBe(201);
    const init = fetch.mock.calls[0][1];
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^vapid /);
    expect(new Headers(init?.headers).get("content-encoding")).toBe("aes128gcm");
    expect(new TextDecoder().decode(init?.body as Uint8Array<ArrayBuffer>)).not.toContain(
      "Private content",
    );
  } finally {
    fetch.mockRestore();
  }
});

it("serves rule changes and publishes an inbox notice from the shared alarm while preserving another queue's wake", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  const request = (path: string, method = "GET", body?: object) =>
    stub.fetch("https://planner.test/api/" + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
    });
  const rule = crypto.randomUUID();
  const at = Date.now() + 1500;
  const result = await request("reminders/" + rule, "PUT", {
    title: "Upcoming appointment",
    enabled: true,
    trigger: { kind: "at", at: new Date(at).toISOString() },
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ id: rule, nextAt: at });
  const later = at + 3600000;
  await runInDurableObject(stub, async (_, ctx) => {
    ctx.storage.kv.put("planner:carryover", { enabled: true, timeZone: "UTC", due: later });
    expect(await ctx.storage.getAlarm()).toBe(at);
  });
  await expect
    .poll(
      async () => {
        const response = await request("agent/inbox?view=updates");
        const inbox = await response.json<{
          items: { title: string; reminderId?: string }[];
          needsAction: number;
        }>();
        expect(inbox.needsAction).toBe(0);
        return inbox.items.filter((i) => i.reminderId === rule).map((i) => i.title);
      },
      { timeout: 8000 },
    )
    .toEqual(["Upcoming appointment"]);
  expect(await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm())).toBe(later);
}, 10000);

it("admits one daily synthesis job, validates its result against current tasks, and falls back on a missed result", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_, ctx) => {
    const db = new SqlitePlannerDatabase(drizzle(ctx.storage));
    const output: string[] = [];
    const jobs: string[] = [];
    const reminders = new PlannerReminders(
      ctx.storage,
      db,
      (n) => output.push(n.body),
      {},
      "scope",
      async (_scope, id, _snapshot) => {
        jobs.push(id);
      },
    );
    reminders.migrate();
    const planner = new Planner(db);
    const now = Date.parse("2032-05-20T09:00:00Z");
    const day = "2032-05-20";
    const task = planner.create(
      createTask.parse({ title: "Send report", schedule: { type: "day", date: day } }),
    );
    planner.create(
      createTask.parse({ title: "Buy groceries", schedule: { type: "day", date: day } }),
    );
    const rule = {
      title: "Daily brief",
      enabled: true,
      trigger: {
        kind: "daily" as const,
        time: "09:00",
        summary: "agenda" as const,
        synthesize: true,
      },
    };
    const commit = async <T>(f: () => T) => ctx.storage.transactionSync(f);
    const id = crypto.randomUUID();
    reminders.set(id, rule, now - 1000);
    await reminders.processDue(commit, now);
    await reminders.processDue(commit, now);
    expect(jobs).toHaveLength(1);
    expect(output).toEqual([]);
    planner.update(task.id, { revision: task.revision, completed: true });
    expect(reminders.finishBrief(jobs[0], [0, 1], now + 1000)).toBe(true);
    expect(reminders.finishBrief(jobs[0], [0], now + 1001)).toBe(false);
    expect(output).toEqual(["In your planner today: Buy groceries."]);
    // A dispatch can be admitted before a deploy or model outage. The planner's
    // stored deadline publishes the baseline, and a late callback finds no job.
    reminders.set(crypto.randomUUID(), rule, now - 1000);
    await reminders.processDue(commit, now);
    await reminders.processDue(commit, now + 30000);
    expect(output).toHaveLength(2);
    expect(reminders.finishBrief(jobs[1], [0], now + 31000)).toBe(false);
  });
});

it("retains delivered occurrence identities across completion, reopening and a round-trip reschedule", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_, ctx) => {
    const db = new SqlitePlannerDatabase(drizzle(ctx.storage));
    const notices: string[] = [];
    const reminders = new PlannerReminders(ctx.storage, db, (n) => notices.push(n.id), {}, "scope");
    const planner = new Planner(db, (t) => reminders.taskChanged(t));
    const at = Date.parse("2032-05-20T14:00:00Z");
    const due = (at: number) => ({
      type: "time" as const,
      at: new Date(at).toISOString(),
      timeZone: "UTC",
    });
    let task = planner.create(createTask.parse({ title: "Publish results", due: due(at) }));
    const rule = crypto.randomUUID();
    reminders.set(
      rule,
      {
        title: "Upcoming deadline",
        enabled: true,
        taskId: task.id,
        trigger: { kind: "before", anchor: "due", minutes: 30 },
      },
      at - 3600000,
    );
    const commit = async <T>(write: () => T) => ctx.storage.transactionSync(write);
    const fire = at - 30 * 60000;
    await reminders.processDue(commit, fire);
    const first = notices[0];
    reminders.act(rule, first, 1, fire);
    await reminders.processDue(commit, fire + 60000);
    expect(new Set(notices).size).toBe(2);
    task = planner.update(task.id, { revision: task.revision, completed: true });
    task = planner.update(task.id, { revision: task.revision, completed: false });
    expect(reminders.nextDue()).toBe(null);
    await reminders.processDue(commit, fire + 60000);
    task = planner.update(task.id, { revision: task.revision, due: due(at + 3600000) });
    expect(reminders.nextDue()).toBe(fire + 3600000);
    planner.update(task.id, { revision: task.revision, due: due(at) });
    expect(reminders.nextDue()).toBe(null);
    await reminders.processDue(commit, fire + 120000);
    expect(notices).toHaveLength(2);
  });
});

it("arms a real alarm and admits a due-task rule when planner backfill is immediate", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  const res = await stub.fetch("https://test/api/reminders/" + crypto.randomUUID(), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Deadlines",
      enabled: true,
      trigger: { kind: "due-tasks", minutes: 15 },
    }),
  });
  expect(res.status).toBe(200);
});

it("dispatches a daily routine once per occurrence and revokes its private conversation when the rule changes", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_, ctx) => {
    const calls: string[] = [];
    const reminders = new PlannerReminders(
      ctx.storage,
      new SqlitePlannerDatabase(drizzle(ctx.storage)),
      () => {},
      {},
      "scope",
      undefined,
      async (owner, id, instruction, day, zone) => {
        expect({ owner, instruction, zone }).toEqual({
          owner: "dev:owner",
          instruction: "Summarize my tasks",
          zone: "UTC",
        });
        expect(day).toMatch(/^2032-05-2[01]$/);
        calls.push(id);
      },
    );
    const now = Date.parse("2032-05-20T09:00:00Z");
    const rule = {
      enabled: true,
      title: "My routine",
      trigger: { kind: "routine" as const, time: "09:00", instruction: "Summarize my tasks" },
    };
    const id = crypto.randomUUID(),
      commit = async <T>(write: () => T) => ctx.storage.transactionSync(write);
    expect(() => reminders.set(id, rule, now - 1000)).toThrow("signed-in");
    reminders.set(id, rule, now - 1000, "dev:owner");
    await reminders.processDue(commit, now);
    await reminders.processDue(commit, now + 1);
    expect(calls).toHaveLength(1);
    const original = calls[0],
      conversation = "routine:" + original + ":dev:owner";
    const turn = original + "/planner_routine//";
    expect(reminders.authorizesRoutine(conversation, turn, now + 1)).toBe(true);
    expect(reminders.authorizesRoutine(conversation + "x", turn, now + 1)).toBe(false);
    const tomorrow = now + 86400000;
    await reminders.processDue(commit, tomorrow);
    expect(calls).toHaveLength(2);
    expect(reminders.authorizesRoutine(conversation, turn, tomorrow)).toBe(false);
    const question = crypto.randomUUID();
    ctx.storage.sql.exec(
      "INSERT INTO agent_inbox(id,kind,status,createdAt,document) VALUES(?,'question','answered',?,?)",
      question,
      new Date(now).toISOString(),
      JSON.stringify({ conversation, title: "Question", body: "Choose one", answer: "First" }),
    );
    expect(
      reminders.authorizesRoutine(
        conversation,
        original + "/inbox_result/" + question + "/1",
        tomorrow,
      ),
    ).toBe(true);
    reminders.set(id, { ...rule, enabled: false }, tomorrow, "dev:owner");
    expect(
      reminders.authorizesRoutine(
        conversation,
        original + "/inbox_result/" + question + "/1",
        tomorrow,
      ),
    ).toBe(false);
    expect(
      reminders.authorizesRoutine(
        "routine:" + calls[1] + ":dev:owner",
        calls[1] + "/planner_routine//",
        tomorrow,
      ),
    ).toBe(false);
  });
});
