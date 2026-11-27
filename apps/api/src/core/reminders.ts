import { Temporal } from "@js-temporal/polyfill";
import type { CommitTaskWrite, PlannerDatabase } from "../interfaces/database.ts";
import type { Task } from "../interfaces/plan.ts";
import type {
  ReminderInput,
  ReminderSettings,
  ReminderSubscription,
} from "../interfaces/reminders.ts";
import { migrateReminders } from "../db/reminders.ts";
import { dispatchReminderBrief } from "../agents/dispatch-reminder-brief.ts";
import { PlannerError } from "./planner.ts";
import { pushPublicKey, sendReminderPush, type ReminderPushEnv } from "./reminder-push.ts";

const minute = 60_000;
const grace = 60 * minute;
const batch = 32;
const settingsKey = "reminders:settings";
const defaults: ReminderSettings = {
  paused: false,
  timeZone: "UTC",
  quietStart: null,
  quietEnd: null,
  dayTime: "09:00",
};
type RuleRow = { id: string; document: string; generation: string; scanAfter: string | null };
type Slot = {
  ruleId: string;
  slot: string;
  taskId: string | null;
  anchor: number;
  due: number | null;
};
type Notice = {
  id: string;
  ruleId: string;
  generation: string;
  taskId: string | null;
  anchor: number;
  expires: number;
  title: string;
  body: string;
  snooze: number | null;
  action: string | null;
};
type BriefTask = {
  title: string;
  due: string | null;
  start: string | null;
  blocked: number;
  id: string;
};
type BriefJob = {
  id: string;
  ruleId: string;
  anchor: number;
  snapshot: string;
  due: number;
  deadline: number;
};
type DeviceJob = { noticeId: string; deviceId: string; attempt: number; document: string };
type InboxNotification = {
  id: string;
  title: string;
  body: string;
  taskId?: string;
  reminderId?: string;
};

function zoned(at: number, zone: string) {
  return Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone);
}
function civilTime(day: Temporal.PlainDate | string, time: string, zone: string) {
  return Temporal.PlainDate.from(day).toZonedDateTime({ timeZone: zone, plainTime: time })
    .epochMilliseconds;
}
function nextDaily(time: string, zone: string, now: number) {
  const day = zoned(now, zone).toPlainDate();
  const today = civilTime(day, time, zone);
  return today > now ? today : civilTime(day.add({ days: 1 }), time, zone);
}

export function afterQuiet(at: number, settings: ReminderSettings): number {
  const { quietStart: start, quietEnd: end, timeZone: zone } = settings;
  if (!start || !end) return at;
  const local = zoned(at, zone);
  const clock = local.toPlainTime().toString().slice(0, 5);
  const quiet = start < end ? clock >= start && clock < end : clock >= start || clock < end;
  if (!quiet) return at;
  const day = local.toPlainDate().add({ days: start > end && clock >= start ? 1 : 0 });
  // The second copy of a folded clock hour must choose the future quiet-hour boundary.
  const first = civilTime(day, end, zone);
  return first > at
    ? first
    : day.toPlainDateTime(end).toZonedDateTime(zone, { disambiguation: "later" }).epochMilliseconds;
}

function taskAnchor(rule: ReminderInput, task: Task | undefined, settings: ReminderSettings) {
  if (task?.completed || (rule.taskId && !task)) return null;
  const trigger = rule.trigger;
  if (trigger.kind === "at") return Date.parse(trigger.at);
  if (trigger.kind === "daily" || trigger.kind === "routine" || !task) return null;
  if (trigger.kind === "before" && trigger.anchor === "start") {
    if (task.schedule?.type === "day")
      return civilTime(task.schedule.date, settings.dayTime, settings.timeZone);
    return task.schedule ? Date.parse(task.schedule.start) : null;
  }
  if (!task.due) return null;
  return task.due.type === "time"
    ? Date.parse(task.due.at)
    : civilTime(task.due.date, settings.dayTime, settings.timeZone);
}

function lead(rule: ReminderInput) {
  return "minutes" in rule.trigger ? rule.trigger.minutes * minute : 0;
}

export class PlannerReminders {
  private readonly sql: SqlStorage;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: PlannerDatabase,
    private readonly publish: (input: InboxNotification) => void,
    private readonly env: ReminderPushEnv,
    private readonly scope: string,
    private readonly synthesize = dispatchReminderBrief,
    private readonly admitRoutine = async (
      owner: string,
      id: string,
      instruction: string,
      day: string,
      zone: string,
    ) => {
      const { dispatchRoutine } = await import("../agents/dispatch-routine.ts");
      await dispatchRoutine(owner, id, instruction, day, zone);
    },
  ) {
    this.sql = storage.sql;
  }

  migrate() {
    migrateReminders(this.sql);
  }
  settings(): ReminderSettings {
    return this.storage.kv.get<ReminderSettings>(settingsKey) ?? defaults;
  }

  private row(id: string) {
    return this.sql.exec<RuleRow>("SELECT * FROM reminder_rule WHERE id=?", id).toArray()[0];
  }

  rule(id: string) {
    const row = this.row(id);
    if (!row) return null;
    const { nextAt } = this.sql
      .exec<{ nextAt: number | null }>(
        "SELECT min(t) AS nextAt FROM (SELECT min(due) t FROM reminder_slot WHERE ruleId=? UNION ALL SELECT min(snooze) t FROM reminder_notice WHERE ruleId=?)",
        id,
        id,
      )
      .one();
    return { ...(JSON.parse(row.document) as ReminderInput), id, nextAt };
  }

  // Approval previews should describe the reviewed intent and the delivery being
  // changed. A relative snooze's absolute deadline is assigned when accepted.
  reviewState(id: string, occurrence?: string) {
    const row = this.row(id);
    if (!row) return null;
    const rule = { id, ...(JSON.parse(row.document) as ReminderInput) };
    if (!occurrence) return rule;
    const target = this.sql
      .exec<{ id: string; anchor: number; action: string | null }>(
        "SELECT id, anchor, action FROM reminder_notice WHERE ruleId=? AND id=?",
        id,
        occurrence,
      )
      .toArray()[0];
    return { rule, occurrence: target ?? null };
  }

  list() {
    return {
      settings: this.settings(),
      pushPublicKey: pushPublicKey(this.env),
      rules: this.sql
        .exec<{ id: string }>("SELECT id FROM reminder_rule ORDER BY id")
        .toArray()
        .map(({ id }) => this.rule(id)!),
    };
  }

  configure(settings: ReminderSettings, now = Date.now()) {
    const before = this.settings();
    this.storage.kv.put(settingsKey, settings);
    if (JSON.stringify(settings) === JSON.stringify(before)) return settings;
    // A different civil zone defines different routine occurrences. Queued and
    // in-flight runs bound to the previous schedule lose their authority.
    if (settings.timeZone !== before.timeZone) this.sql.exec("DELETE FROM reminder_routine_run");
    for (const row of this.sql.exec<RuleRow>("SELECT * FROM reminder_rule").toArray()) {
      const rule = JSON.parse(row.document) as ReminderInput;
      if (rule.trigger.kind === "due-tasks") {
        if (rule.enabled) this.sql.exec("UPDATE reminder_rule SET scanAfter='' WHERE id=?", row.id);
      } else if (
        (rule.trigger.kind === "daily" || rule.trigger.kind === "routine") &&
        before.timeZone === settings.timeZone
      ) {
        // Published days must stay published; preserve the next scheduled day.
        this.sql.exec(
          "UPDATE reminder_slot SET due=anchor WHERE ruleId=? AND due IS NOT NULL",
          row.id,
        );
      } else
        this.reconcile(row, rule, rule.taskId ? this.db.task(rule.taskId) : undefined, now, true);
    }
    return settings;
  }

  set(id: string, rule: ReminderInput, now = Date.now(), owner?: string) {
    // Only a verified planner owner can bind a routine. Chat-created routines go through human review.
    if (rule.trigger.kind === "routine" && !owner)
      throw new PlannerError(
        409,
        "Set up scheduled agent instructions from your signed-in reminder settings.",
      );
    if (rule.taskId && !this.db.task(rule.taskId)) throw new PlannerError(404, "Task not found.");
    const doc = JSON.stringify(rule);
    const old = this.row(id);
    if (old?.document === doc) return this.rule(id)!;
    if (
      !old &&
      this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM reminder_rule").one().n >= 250
    )
      throw new PlannerError(409, "A planner can have up to 250 reminder rules.");
    this.remove(id);
    const generation = crypto.randomUUID();
    const scanAfter = rule.enabled && rule.trigger.kind === "due-tasks" ? "" : null;
    this.sql.exec(
      "INSERT INTO reminder_rule(id,taskId,kind,document,generation,scanAfter) VALUES(?,?,?,?,?,?)",
      id,
      rule.taskId ?? null,
      rule.trigger.kind,
      doc,
      generation,
      scanAfter,
    );
    if (rule.trigger.kind === "routine")
      this.sql.exec("INSERT INTO reminder_routine_owner(ruleId,owner) VALUES(?,?)", id, owner!);
    if (rule.trigger.kind !== "due-tasks")
      this.reconcile(
        { id, generation, document: doc, scanAfter },
        rule,
        rule.taskId ? this.db.task(rule.taskId) : undefined,
        now,
      );
    return this.rule(id)!;
  }

  remove(id: string) {
    this.sql.exec("DELETE FROM reminder_rule WHERE id=?", id);
    return { id };
  }

  taskChanged(task: Task, now = Date.now()) {
    const rows = this.sql.exec<RuleRow>(
      "SELECT * FROM reminder_rule WHERE taskId=? OR kind='due-tasks'",
      task.id,
    );
    for (const row of rows.toArray())
      this.reconcile(row, JSON.parse(row.document) as ReminderInput, task, now);
  }

  private reconcile(
    row: RuleRow,
    rule: ReminderInput,
    task: Task | undefined,
    now: number,
    reschedule = false,
  ) {
    const slot = task?.id ?? "";
    const settings = this.settings();
    const anchor = !rule.enabled
      ? null
      : rule.trigger.kind === "daily" || rule.trigger.kind === "routine"
        ? nextDaily(rule.trigger.time, settings.timeZone, now)
        : taskAnchor(rule, task, settings);
    if (anchor === null) {
      this.sql.exec("DELETE FROM reminder_slot WHERE ruleId=? AND slot=?", row.id, slot);
      if (task)
        this.sql.exec("DELETE FROM reminder_notice WHERE ruleId=? AND taskId=?", row.id, task.id);
      return;
    }
    const delivered =
      this.sql
        .exec(
          "SELECT 1 FROM reminder_occurrence WHERE ruleId=? AND slot=? AND anchor=? AND source=''",
          row.id,
          slot,
          anchor,
        )
        .toArray().length > 0;
    const due = delivered ? null : anchor - lead(rule);
    this.sql.exec(
      `INSERT INTO reminder_slot(ruleId,slot,taskId,anchor,due) VALUES(?,?,?,?,?)
			ON CONFLICT(ruleId,slot) DO UPDATE SET anchor=excluded.anchor,due=excluded.due
			WHERE reminder_slot.anchor<>excluded.anchor OR (? AND reminder_slot.due IS NOT NULL)`,
      row.id,
      slot,
      task?.id ?? null,
      anchor,
      due,
      reschedule ? 1 : 0,
    );
    if (task)
      this.sql.exec(
        "DELETE FROM reminder_notice WHERE ruleId=? AND taskId=? AND anchor<>?",
        row.id,
        task.id,
        anchor,
      );
  }

  nextDue(): number | null {
    if (this.settings().paused) return null;
    const row = this.sql
      .exec<Record<string, number | null>>(`SELECT
      (SELECT min(due) FROM reminder_slot) AS slot,
      (SELECT min(snooze) FROM reminder_notice) AS snooze,
      (SELECT min(due) FROM reminder_routine_run) AS routine,
      (SELECT min(due) FROM reminder_brief) AS brief,
      (SELECT min(due) FROM reminder_push) AS push,
      (SELECT 1 FROM reminder_rule WHERE scanAfter IS NOT NULL LIMIT 1) AS backfill`)
      .one();
    const pending = Object.values(row).filter((at): at is number => at !== null);
    // A past alarm wakes immediately, but workerd rejects zero or negative epoch times.
    return pending.length ? Math.max(1, Math.min(...pending)) : null;
  }

  private backfill(now: number) {
    const row = this.sql
      .exec<RuleRow>("SELECT * FROM reminder_rule WHERE scanAfter IS NOT NULL ORDER BY id LIMIT 1")
      .toArray()[0];
    if (!row) return;
    const tasks = this.sql
      .exec<{ document: string }>(
        "SELECT document FROM task WHERE id>? ORDER BY id LIMIT ?",
        row.scanAfter,
        batch,
      )
      .toArray();
    let cursor: string | null = null;
    const rule = JSON.parse(row.document) as ReminderInput;
    for (const value of tasks) {
      const task = JSON.parse(value.document) as Task;
      this.reconcile(row, rule, task, now, true);
      cursor = task.id;
    }
    this.sql.exec(
      "UPDATE reminder_rule SET scanAfter=? WHERE id=?",
      tasks.length < batch ? null : cursor,
      row.id,
    );
  }

  private summary(kind: "agenda" | "blocked", day: string, zone: string) {
    const end = civilTime(Temporal.PlainDate.from(day).add({ days: 1 }), "00:00", zone);
    const start = civilTime(day, "00:00", zone);
    const args = [day, day, start / 1000, end / 1000, start / 1000, end / 1000];
    const upcoming = `(json_extract(t.document,'$.currentDay')=? OR json_extract(t.document,'$.due.date')=?
			OR unixepoch(json_extract(t.document,'$.due.at')) >= ? AND unixepoch(json_extract(t.document,'$.due.at')) < ?
			OR unixepoch(json_extract(t.document,'$.schedule.start')) >= ? AND unixepoch(json_extract(t.document,'$.schedule.start')) < ?)`;
    const blocked = `EXISTS(SELECT 1 FROM dependency d JOIN task p ON p.id=d.prerequisite
			WHERE d.dependent=t.id AND json_extract(p.document,'$.completed')=0)`;
    return this.sql
      .exec<BriefTask>(
        `SELECT t.id, json_extract(t.document,'$.title') title, coalesce(json_extract(t.document,'$.due.at'),json_extract(t.document,'$.due.date')) due, json_extract(t.document,'$.schedule.start') start, ${blocked} blocked FROM task t
			WHERE json_extract(t.document,'$.completed')=0 AND ${upcoming} ${kind === "blocked" ? "AND " + blocked : ""}
			ORDER BY t.id LIMIT 6`,
        ...args,
      )
      .toArray();
  }

  private renderBrief(kind: "agenda" | "blocked", tasks: BriefTask[], order: number[] = []) {
    const sorted = [...new Set([...order, ...tasks.map((_, i) => i)])].map((i) => tasks[i]);
    return (
      (kind === "blocked" ? "Waiting on prerequisites today: " : "In your planner today: ") +
      sorted
        .slice(0, 5)
        .map((t) => t.title)
        .join(", ") +
      (tasks.length > 5 ? ", and more." : ".")
    );
  }

  finishBrief(jobId: string, order: number[], now = Date.now()) {
    const job = this.sql
      .exec<BriefJob>("SELECT * FROM reminder_brief WHERE id=?", jobId)
      .toArray()[0];
    if (!job) return false;
    const ruleRow = this.row(job.ruleId)!;
    const rule = JSON.parse(ruleRow.document) as ReminderInput;
    const settings = this.settings();
    if (settings.paused) return false;
    const quietEnd = afterQuiet(now, settings);
    if (quietEnd > now) {
      this.sql.exec("UPDATE reminder_brief SET due=? WHERE id=?", quietEnd, jobId);
      return false;
    }
    this.sql.exec("DELETE FROM reminder_brief WHERE id=?", job.id);
    if (!rule.enabled || rule.trigger.kind !== "daily" || now > job.anchor + grace) return false;
    const date = zoned(job.anchor, settings.timeZone).toPlainDate().toString();
    const tasks = this.summary(rule.trigger.summary, date, settings.timeZone);
    if (!tasks.length) return false;
    const sameSnapshot = JSON.stringify(tasks) === job.snapshot;
    const validOrder =
      order.length <= 5 &&
      new Set(order).size === order.length &&
      order.every((i) => Number.isInteger(i) && i >= 0 && i < tasks.length);
    const body = this.renderBrief(
      rule.trigger.summary,
      tasks,
      sameSnapshot && validOrder ? order : [],
    );
    this.emit(
      ruleRow.id,
      ruleRow.generation,
      null,
      job.anchor,
      job.anchor + grace,
      rule.title,
      body,
      now,
    );
    return true;
  }

  private async deliverBriefs(commit: CommitTaskWrite, now: number) {
    const jobs = await commit(() => {
      if (this.settings().paused) return [];
      const jobs = this.sql
        .exec<BriefJob>("SELECT * FROM reminder_brief WHERE due<=? ORDER BY due LIMIT 4", now)
        .toArray();
      const dispatch: BriefJob[] = [];
      for (const job of jobs) {
        if (now >= job.deadline) this.finishBrief(job.id, [], now);
        else {
          this.sql.exec("UPDATE reminder_brief SET due=? WHERE id=?", job.deadline, job.id);
          dispatch.push(job);
        }
      }
      return dispatch;
    });
    await Promise.all(
      jobs.map(async (job) => {
        // Dispatch waits only for durable admission. The model runs in its own object and
        // the shared planner alarm can deliver other reminders during model execution.
        try {
          await this.synthesize(this.scope, job.id, job.snapshot);
        } catch {
          await commit(() => this.finishBrief(job.id, [], now));
        }
      }),
    );
  }

  private emit(
    ruleId: string,
    generation: string,
    taskId: string | null,
    anchor: number,
    expires: number,
    title: string,
    body: string,
    now: number,
    source = "",
  ) {
    // One durable receipt per source occurrence. Returning a task to an earlier
    // schedule or reopening it may recreate its slot, but cannot repeat delivery.
    const inserted =
      this.sql
        .exec(
          "INSERT INTO reminder_occurrence(ruleId,slot,anchor,source,expires) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING 1",
          ruleId,
          taskId ?? "",
          anchor,
          source,
          expires,
        )
        .toArray().length > 0;
    if (!inserted) return;
    const id = crypto.randomUUID();
    this.publish({ id, title, body, reminderId: ruleId, ...(taskId && { taskId }) });
    this.sql.exec(
      "INSERT INTO reminder_notice(id,ruleId,taskId,generation,anchor,expires,created,title,body) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      ruleId,
      taskId,
      generation,
      anchor,
      expires,
      now,
      title,
      body,
    );
    if (pushPublicKey(this.env))
      this.sql.exec(
        "INSERT INTO reminder_push(noticeId,deviceId,due) SELECT ?,id,? FROM reminder_device",
        id,
        now,
      );
  }

  private dueSlot(slot: Slot, settings: ReminderSettings, now: number) {
    const row = this.row(slot.ruleId)!;
    const rule = JSON.parse(row.document) as ReminderInput;
    const trigger = rule.trigger;
    const task = slot.taskId ? this.db.task(slot.taskId) : undefined;
    if (
      !rule.enabled ||
      (trigger.kind !== "daily" &&
        trigger.kind !== "routine" &&
        taskAnchor(rule, task, settings) !== slot.anchor)
    ) {
      this.reconcile(row, rule, task, now);
      return;
    }
    const quietEnd = afterQuiet(now, settings);
    if (quietEnd > now) {
      this.sql.exec(
        "UPDATE reminder_slot SET due=? WHERE ruleId=? AND slot=?",
        quietEnd,
        row.id,
        slot.slot,
      );
      return;
    }
    const expires = lead(rule) ? slot.anchor : slot.anchor + grace;
    if (now <= expires) {
      const display = zoned(slot.anchor, settings.timeZone).toPlainTime().toString().slice(0, 5);
      if (trigger.kind === "routine") {
        const claimed =
          this.sql
            .exec(
              "INSERT OR IGNORE INTO reminder_occurrence(ruleId,slot,anchor,source,expires) VALUES(?,?,?,?,?) RETURNING 1",
              row.id,
              "",
              slot.anchor,
              "routine",
              expires,
            )
            .toArray().length > 0;
        if (claimed) {
          const day = zoned(slot.anchor, settings.timeZone).toPlainDate().toString();
          this.sql.exec(
            "INSERT INTO reminder_routine_run(id,ruleId,anchor,expires,due,day,zone) VALUES(?,?,?,?,?,?,?)",
            crypto.randomUUID(),
            row.id,
            slot.anchor,
            nextDaily(trigger.time, settings.timeZone, now),
            now,
            day,
            settings.timeZone,
          );
        }
      } else if (trigger.kind === "daily") {
        const date = zoned(slot.anchor, settings.timeZone).toPlainDate().toString();
        const tasks = this.summary(trigger.summary, date, settings.timeZone);
        if (tasks.length && trigger.synthesize) {
          this.sql.exec(
            "INSERT INTO reminder_brief(id,ruleId,snapshot,anchor,due,deadline) VALUES(?,?,?,?,?,?)",
            crypto.randomUUID(),
            row.id,
            JSON.stringify(tasks),
            slot.anchor,
            now,
            now + 30_000,
          );
        } else if (tasks.length) {
          this.emit(
            row.id,
            row.generation,
            null,
            slot.anchor,
            expires,
            rule.title,
            this.renderBrief(trigger.summary, tasks),
            now,
          );
        }
      } else {
        const body =
          trigger.kind === "at"
            ? (task?.title ?? rule.title)
            : task!.title +
              (trigger.kind === "before" && trigger.anchor === "start"
                ? " starts at "
                : " is due at ") +
              display +
              ".";
        this.emit(row.id, row.generation, slot.taskId, slot.anchor, expires, rule.title, body, now);
      }
    }
    if (trigger.kind === "daily" || trigger.kind === "routine")
      this.reconcile(row, rule, undefined, now);
    else
      this.sql.exec(
        "UPDATE reminder_slot SET due=NULL WHERE ruleId=? AND slot=?",
        row.id,
        slot.slot,
      );
  }

  act(ruleId: string, occurrence: string, minutes?: number, now = Date.now()) {
    const notice = this.sql
      .exec<Notice>("SELECT * FROM reminder_notice WHERE id=? AND ruleId=?", occurrence, ruleId)
      .toArray()[0];
    if (!notice) throw new PlannerError(404, "Reminder occurrence not found.");
    const action = minutes === undefined ? "dismiss" : "snooze:" + minutes;
    if (notice.action === action) return { id: occurrence };
    if (notice.action !== null) throw new PlannerError(409, "This occurrence was already handled.");
    if (notice.expires < now) throw new PlannerError(409, "This reminder has expired.");
    this.sql.exec(
      "UPDATE reminder_notice SET action=?,snooze=? WHERE id=?",
      action,
      minutes === undefined ? null : now + minutes * minute,
      occurrence,
    );
    this.sql.exec("DELETE FROM reminder_push WHERE noticeId=?", occurrence);
    return { id: occurrence };
  }

  private dueSnooze(notice: Notice, settings: ReminderSettings, now: number) {
    const due = afterQuiet(now, settings);
    if (due > now) {
      this.sql.exec("UPDATE reminder_notice SET snooze=? WHERE id=?", due, notice.id);
      return;
    }
    this.sql.exec("UPDATE reminder_notice SET snooze=NULL WHERE id=?", notice.id);
    if (now > notice.snooze! + grace || (notice.taskId && this.db.task(notice.taskId)?.completed))
      return;
    this.emit(
      notice.ruleId,
      notice.generation,
      notice.taskId,
      notice.anchor,
      now + grace,
      notice.title,
      notice.body,
      now,
      notice.id,
    );
  }

  subscribe(id: string, subscription: ReminderSubscription) {
    if (!pushPublicKey(this.env)) throw new PlannerError(409, "Web Push is not configured.");
    const doc = JSON.stringify(subscription);
    const old = this.sql
      .exec<{ document: string }>("SELECT document FROM reminder_device WHERE id=?", id)
      .toArray()[0];
    if (old?.document === doc) return { id };
    this.sql.exec(
      "DELETE FROM reminder_device WHERE id=? OR endpoint=?",
      id,
      subscription.endpoint,
    );
    if (this.sql.exec<{ n: number }>("SELECT count(*) n FROM reminder_device").one().n >= 16)
      throw new PlannerError(409, "This planner already has 16 subscribed devices.");
    this.sql.exec(
      "INSERT INTO reminder_device(id,endpoint,document) VALUES(?,?,?)",
      id,
      subscription.endpoint,
      doc,
    );
    return { id };
  }
  unsubscribe(id: string) {
    this.sql.exec("DELETE FROM reminder_device WHERE id=?", id);
    return { id };
  }

  private claimPush(now: number): DeviceJob | undefined {
    const job = this.sql
      .exec<DeviceJob>(
        `SELECT p.*,d.document FROM reminder_push p
			JOIN reminder_device d ON p.deviceId=d.id WHERE p.due<=? ORDER BY p.due LIMIT 1`,
        now,
      )
      .toArray()[0];
    if (job)
      this.sql.exec(
        "UPDATE reminder_push SET due=?,attempt=attempt+1 WHERE noticeId=? AND deviceId=?",
        now + minute,
        job.noticeId,
        job.deviceId,
      );
    return job;
  }

  authorizesRoutine(conversation?: string, submission?: string, now = Date.now()) {
    if (!conversation?.startsWith("routine:") || this.settings().paused) return false;
    const run = conversation.split(":", 2)[1];
    const row = this.sql
      .exec<{ owner: string; expires: number }>(
        "SELECT o.owner,u.expires FROM reminder_routine_run u JOIN reminder_routine_owner o USING(ruleId) WHERE u.id=? AND u.attempts>0",
        run,
      )
      .toArray()[0];
    if (!row || conversation !== `routine:${run}:${row.owner}`) return false;
    const [runId, type, itemId, version] = (submission ?? "").split("/");
    if (runId !== run) return false;
    if (type === "planner_routine") return row.expires > now;
    if (!itemId || !["inbox_result", "inbox_revision"].includes(type)) return false;
    // An outstanding question can be answered after the next day's run.
    // Only the server's decision signal can resume its original conversation.
    return (
      this.sql
        .exec(
          "SELECT 1 FROM agent_inbox WHERE id=? AND version=? AND status<>'pending' AND json_extract(document,'$.conversation')=?",
          itemId,
          Number(version),
          conversation,
        )
        .toArray().length > 0
    );
  }

  private async deliverRoutines(commit: CommitTaskWrite, now: number) {
    const jobs = await commit(() => {
      if (this.settings().paused) return [];
      this.sql.exec(
        "DELETE FROM reminder_routine_run WHERE rowid IN (SELECT rowid FROM reminder_routine_run WHERE due IS NOT NULL AND expires<=? LIMIT ?)",
        now,
        batch,
      );
      const rows = this.sql
        .exec<{
          id: string;
          owner: string;
          document: string;
          attempts: number;
          day: string;
          zone: string;
          expires: number;
        }>(
          `SELECT u.id,o.owner,r.document,u.attempts,u.day,u.zone,u.expires FROM reminder_routine_run u
         JOIN reminder_routine_owner o USING(ruleId) JOIN reminder_rule r ON r.id=u.ruleId
         WHERE u.due<=? AND u.expires>? ORDER BY u.due LIMIT 4`,
          now,
          now,
        )
        .toArray();
      for (const job of rows)
        this.sql.exec(
          "UPDATE reminder_routine_run SET due=?, attempts=attempts+1 WHERE id=?",
          Math.min(job.expires, now + minute),
          job.id,
        );
      return rows;
    });
    await Promise.all(
      jobs.map(async (job) => {
        const rule = JSON.parse(job.document) as ReminderInput;
        if (rule.trigger.kind !== "routine") return;
        try {
          await this.admitRoutine(job.owner, job.id, rule.trigger.instruction, job.day, job.zone);
          await commit(() => {
            this.sql.exec("UPDATE reminder_routine_run SET due=NULL WHERE id=?", job.id);
          });
        } catch {
          await commit(() => {
            this.sql.exec(
              "UPDATE reminder_routine_run SET due=? WHERE id=? AND attempts=?",
              Math.min(job.expires, now + minute * 2 ** Math.min(job.attempts, 6)),
              job.id,
              job.attempts + 1,
            );
          });
        }
      }),
    );
  }

  async processDue(commit: CommitTaskWrite, now = Date.now()) {
    const firstDue = this.nextDue();
    if (firstDue === null || firstDue > now) return;
    await commit(() => {
      const settings = this.settings();
      if (settings.paused) return;
      this.sql.exec(
        "DELETE FROM reminder_occurrence WHERE rowid IN (SELECT rowid FROM reminder_occurrence WHERE expires < ? LIMIT ?)",
        now - grace,
        batch,
      );
      this.backfill(now);
      for (const slot of this.sql
        .exec<Slot>("SELECT * FROM reminder_slot WHERE due<=? ORDER BY due LIMIT ?", now, batch)
        .toArray())
        this.dueSlot(slot, settings, now);
      for (const notice of this.sql
        .exec<Notice>(
          "SELECT * FROM reminder_notice WHERE snooze<=? ORDER BY snooze LIMIT ?",
          now,
          batch,
        )
        .toArray())
        this.dueSnooze(notice, settings, now);
    });
    await this.deliverBriefs(commit, now);
    await this.deliverRoutines(commit, now);
    for (let i = 0; i < 4; i++) {
      const job = await commit(() => (this.settings().paused ? undefined : this.claimPush(now)));
      if (!job) return;
      const notice = this.sql
        .exec<Notice>("SELECT * FROM reminder_notice WHERE id=?", job.noticeId)
        .toArray()[0];
      const settings = this.settings();
      const quietEnd = afterQuiet(now, settings);
      if (quietEnd > now || settings.paused) {
        await commit(() =>
          this.sql.exec(
            "UPDATE reminder_push SET due=? WHERE noticeId=? AND deviceId=?",
            quietEnd,
            job.noticeId,
            job.deviceId,
          ),
        );
        return;
      }
      let status = 204;
      const sub = JSON.parse(job.document) as ReminderSubscription;
      if (sub.expirationTime && sub.expirationTime <= now) status = 410;
      else if (notice && !notice.action && notice.expires >= now) {
        try {
          status = await sendReminderPush(this.env, sub, notice, notice.expires, this.scope);
        } catch {
          status = 503;
        }
      }
      await commit(() => {
        const keys = [job.noticeId, job.deviceId, job.attempt + 1];
        if (status === 404 || status === 410)
          this.sql.exec(
            "DELETE FROM reminder_device WHERE id=? AND document=?",
            job.deviceId,
            job.document,
          );
        else if ((status === 429 || status >= 500) && job.attempt < 5)
          this.sql.exec(
            "UPDATE reminder_push SET due=? WHERE noticeId=? AND deviceId=? AND attempt=?",
            now + Math.pow(2, job.attempt) * minute,
            ...keys,
          );
        else
          this.sql.exec(
            "DELETE FROM reminder_push WHERE noticeId=? AND deviceId=? AND attempt=?",
            ...keys,
          );
      });
    }
  }
}
