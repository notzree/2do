import { Temporal } from "@js-temporal/polyfill";
import { eq, sql } from "drizzle-orm";
import { days, taskCaptures, tasks } from "../db/schema.ts";
import type { PlannerStore } from "../db/planner.ts";
import type { Task } from "../interfaces/plan.ts";
import type { Planner } from "./planner.ts";
import { scheduleDay } from "./task-days.ts";

type Settings = { enabled: boolean; timeZone: string };
type State = Settings & { due: number | null };
const settingsKey = "planner:carryover";

function dueDay(task: Task, zone: string) {
  if (task.due?.type === "day") return task.due.date;
  if (task.due?.type === "time")
    return Temporal.Instant.from(task.due.at).toZonedDateTimeISO(zone).toPlainDate().toString();
}

function sixAM(day: Temporal.PlainDate, timeZone: string) {
  return day.toZonedDateTime({ timeZone, plainTime: "06:00" }).epochMilliseconds;
}

export class Carryover {
  constructor(
    private readonly db: PlannerStore,
    private readonly planner: Planner,
    private readonly kv: DurableObjectStorage["kv"],
    private readonly defaultZone: () => string,
  ) {}

  private state(): State {
    return (
      this.kv.get<State>(settingsKey) ?? { enabled: false, timeZone: this.defaultZone(), due: null }
    );
  }
  settings(): Settings {
    const { enabled, timeZone } = this.state();
    return { enabled, timeZone };
  }
  configure(settings: Settings, now = Date.now()) {
    const state = this.state();
    if (settings.enabled === state.enabled && settings.timeZone === state.timeZone) return settings;
    const day = Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO(settings.timeZone)
      .toPlainDate();
    const today = sixAM(day, settings.timeZone);
    const due = today > now ? today : sixAM(day.add({ days: 1 }), settings.timeZone);
    this.kv.put(settingsKey, { ...settings, due: settings.enabled ? due : null });
    return settings;
  }
  nextDue() {
    return this.state().due;
  }

  run(date: string, zone = this.settings().timeZone) {
    const previous = Temporal.PlainDate.from(date).subtract({ days: 1 }).toString();
    return this.db.transaction(() => {
      const page = this.db.select().from(days).where(eq(days.day, previous)).get();
      const embedded = new Set(
        page?.document.content.flatMap((n) => (n.type === "taskRef" ? [n.attrs.id] : [])),
      );
      let moved = 0;
      // New tasks carry an explicit day. Older documents may only have a schedule or a notebook reference.
      const candidates = this.db
        .select({ task: tasks.document, capture: taskCaptures.document })
        .from(tasks)
        .leftJoin(taskCaptures, eq(taskCaptures.taskId, tasks.id))
        .where(sql`json_extract(${tasks.document}, '$.currentDay') = ${previous}
            OR json_extract(${tasks.document}, '$.currentDay') IS NULL`)
        .all();
      const onDay: typeof candidates = [];
      const undatedChildren = new Map<string, typeof candidates>();
      for (const row of candidates) {
        const { task, capture } = row;
        const legacyDay =
          task.currentDay === undefined
            ? (scheduleDay(task.schedule, zone) ?? capture?.notebookDate)
            : undefined;
        const assignedDay =
          task.currentDay ?? legacyDay ?? (embedded.has(task.id) ? previous : dueDay(task, zone));
        if (assignedDay === previous) onDay.push(row);
        else if (!assignedDay && task.parentId) {
          const siblings = undatedChildren.get(task.parentId) ?? [];
          siblings.push(row);
          undatedChildren.set(task.parentId, siblings);
        }
      }
      // Undated children follow their parent. A child with its own date keeps that assignment.
      for (const { task, capture } of onDay) {
        for (const child of undatedChildren.get(task.id) ?? []) onDay.push(child);
        if (task.completed || task.kind === "event") continue;
        this.planner.carry(task, previous, date, zone, capture?.captureDate);
        moved++;
      }
      return { from: previous, to: date, moved };
    });
  }

  // Advance one local day per delivery so an interrupted or late alarm can safely catch up.
  processDue(now = Date.now()) {
    const state = this.state();
    if (state.due === null || state.due > now) return;
    const day = Temporal.Instant.fromEpochMilliseconds(state.due)
      .toZonedDateTimeISO(state.timeZone)
      .toPlainDate();
    this.run(day.toString(), state.timeZone);
    this.kv.put(settingsKey, { ...state, due: sixAM(day.add({ days: 1 }), state.timeZone) });
  }
}
