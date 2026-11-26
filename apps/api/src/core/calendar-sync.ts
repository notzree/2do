import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { PlannerStore } from "../db/planner.ts";
import { calendarLinks, tasks } from "../db/schema.ts";
import type { Calendar, CalendarEvent, Directions, EventFields } from "../interfaces/connectors.ts";
import { createTask, type Task } from "../interfaces/plan.ts";
import { Planner, PlannerError } from "./planner.ts";

export function fieldsFor(task: Task | undefined): EventFields | null {
  if (task?.kind !== "event" || !task.schedule || task.schedule.type === "window") return null;
  return { title: task.title, schedule: task.schedule };
}
function sameSchedule(a: EventFields["schedule"], b: EventFields["schedule"]) {
  if (a.type === "day" && b.type === "day")
    return a.date === b.date && a.endDateExclusive === b.endDateExclusive;
  return (
    a.type === "fixed" &&
    b.type === "fixed" &&
    Date.parse(a.start) === Date.parse(b.start) &&
    Date.parse(a.end) === Date.parse(b.end)
  );
}
export function sameFields(a: EventFields, b: EventFields) {
  return a.title === b.title && sameSchedule(a.schedule, b.schedule);
}
/** Merge independent title and interval changes from their last common value. */
export function mergeFields(
  base: EventFields,
  local: EventFields,
  remote: EventFields,
): EventFields | null {
  const localTitle = local.title !== base.title,
    remoteTitle = remote.title !== base.title;
  const localTime = !sameSchedule(local.schedule, base.schedule),
    remoteTime = !sameSchedule(remote.schedule, base.schedule);
  if (
    (localTitle && remoteTitle && local.title !== remote.title) ||
    (localTime && remoteTime && !sameSchedule(local.schedule, remote.schedule))
  )
    return null;
  return {
    title: localTitle ? local.title : remote.title,
    schedule: localTime ? local.schedule : remote.schedule,
  };
}

export class PlannerCalendars {
  processingImport = false;
  constructor(
    private store: PlannerStore,
    private planner: Planner,
  ) {}
  private apply<T>(fn: () => T) {
    this.processingImport = true;
    try {
      return fn();
    } finally {
      this.processingImport = false;
    }
  }
  link(taskId: string) {
    return this.store.select().from(calendarLinks).where(eq(calendarLinks.taskId, taskId)).get();
  }
  guard(task: Task, previous?: Task) {
    if (this.processingImport || !previous) return;
    const link = this.link(task.id);
    if (link?.origin !== "google") return;
    if (
      previous.kind !== task.kind ||
      previous.title !== task.title ||
      JSON.stringify(previous.schedule) !== JSON.stringify(task.schedule)
    )
      throw new PlannerError(409, "Edit this imported event in Google Calendar.");
  }
  status(id: string) {
    const link = this.link(id);
    if (!link) return "unlinked" as const;
    if (link.origin === "google") return "imported" as const;
    return link.conflict ? ("conflict" as const) : ("linked" as const);
  }
  publish(id: string, account: string, enabled: boolean) {
    const existing = this.link(id);
    if (existing?.origin === "google")
      throw new PlannerError(409, "This event belongs to Google Calendar.");
    if (!enabled) {
      this.store.delete(calendarLinks).where(eq(calendarLinks.taskId, id)).run();
      return;
    }
    if (!fieldsFor(this.planner.get(id)))
      throw new PlannerError(409, "Choose an event with a date or fixed time.");
    if (existing && existing.account !== account)
      throw new PlannerError(409, "Unlink the previous account first.");
    if (!existing)
      this.store
        .insert(calendarLinks)
        .values({
          taskId: id,
          account,
          origin: "planner",
          remoteId: crypto.randomUUID().replaceAll("-", ""),
        })
        .run();
  }
  importPage(account: string, generation: string, events: CalendarEvent[]) {
    this.apply(() => {
      for (const event of events) {
        if (!event.fields) continue;
        const link = this.store
          .select()
          .from(calendarLinks)
          .where(
            and(
              eq(calendarLinks.origin, "google"),
              eq(calendarLinks.account, account),
              eq(calendarLinks.remoteId, event.id),
            ),
          )
          .get();
        if (link) {
          // A removed local projection stays hidden. Keep its mapping for replay.
          const task = this.store
            .select()
            .from(tasks)
            .where(eq(tasks.id, link.taskId))
            .get()?.document;
          const current = fieldsFor(task);
          if (task && (!current || !sameFields(current, event.fields)))
            this.planner.update(task.id, { revision: task.revision, ...event.fields });
          this.store
            .update(calendarLinks)
            .set({ seen: generation })
            .where(eq(calendarLinks.taskId, link.taskId))
            .run();
        } else {
          const task = this.planner.create(createTask.parse({ ...event.fields, kind: "event" }));
          this.store
            .insert(calendarLinks)
            .values({
              taskId: task.id,
              account,
              remoteId: event.id,
              origin: "google",
              seen: generation,
            })
            .run();
        }
      }
    });
  }
  finishImport(account: string, generation: string) {
    const absent = this.store
      .select({ link: calendarLinks, task: tasks.document })
      .from(calendarLinks)
      .leftJoin(tasks, eq(tasks.id, calendarLinks.taskId))
      .where(
        and(
          eq(calendarLinks.account, account),
          eq(calendarLinks.origin, "google"),
          or(
            ne(calendarLinks.seen, generation),
            // An earlier sweep may have removed the schedule and left an inferred deadline.
            and(
              isNull(calendarLinks.seen),
              sql`json_extract(${tasks.document}, '$.due.type') IS NOT NULL`,
            ),
          ),
        ),
      )
      .limit(100)
      .all();
    this.apply(() => {
      for (const { link, task } of absent) {
        // Retain stable IDs and notebook/dependency references when a meeting disappears.
        if (task && (task.schedule || task.due))
          this.planner.update(task.id, { revision: task.revision, schedule: null, due: null });
        this.store
          .update(calendarLinks)
          .set({ seen: null })
          .where(eq(calendarLinks.taskId, link.taskId))
          .run();
      }
    });
    return absent.length === 100;
  }
  exportPage(account: string, after: string) {
    return this.store
      .select({ link: calendarLinks, task: tasks.document })
      .from(calendarLinks)
      .leftJoin(tasks, eq(calendarLinks.taskId, tasks.id))
      .where(
        and(
          eq(calendarLinks.account, account),
          eq(calendarLinks.origin, "planner"),
          gt(calendarLinks.taskId, after),
        ),
      )
      .orderBy(asc(calendarLinks.taskId))
      .limit(8)
      .all();
  }
  settle(id: string, remoteId: string, before: Task | null, result: ExportResult) {
    const link = this.link(id);
    if (link?.remoteId !== remoteId) return;
    const task = this.store.select().from(tasks).where(eq(tasks.id, id)).get()?.document;
    if (result.kind === "deleted" || result.kind === "detach") {
      if (result.kind === "deleted") {
        if (!task || task.revision !== before?.revision)
          throw new PlannerError(409, "The local event changed during calendar deletion.");
        this.planner.remove(id, task.revision);
      }
      this.store.delete(calendarLinks).where(eq(calendarLinks.taskId, id)).run();
      return;
    }
    if (!task) return;
    if (result.kind === "conflict") {
      this.store
        .update(calendarLinks)
        .set({ conflict: true })
        .where(eq(calendarLinks.taskId, id))
        .run();
      return;
    }
    let target = result.fields;
    if (task.revision !== before?.revision) {
      const previous = fieldsFor(before ?? undefined),
        current = fieldsFor(task);
      const reconciled = previous && current && mergeFields(previous, current, result.fields);
      if (!reconciled) {
        this.store
          .update(calendarLinks)
          .set({ conflict: true })
          .where(eq(calendarLinks.taskId, id))
          .run();
        return;
      }
      target = reconciled;
    }
    const current = fieldsFor(task);
    if (current && !sameFields(current, target))
      this.apply(() => this.planner.update(id, { revision: task.revision, ...target }));
    this.store
      .update(calendarLinks)
      .set({ base: result.fields, conflict: false })
      .where(eq(calendarLinks.taskId, id))
      .run();
  }
}
export type ExportResult =
  | { kind: "deleted" }
  | { kind: "detach" }
  | { kind: "conflict" }
  | { kind: "sync"; fields: EventFields; apply: boolean; written: boolean };
export type ExportRow = ReturnType<PlannerCalendars["exportPage"]>[number];
export async function reconcileExport(
  calendar: Calendar,
  destination: string,
  owner: string,
  options: Directions,
  { task, link, deleteRevision }: ExportRow & { deleteRevision?: number },
  beginDeletion?: (taskId: string, remoteId: string, revision: number) => Promise<boolean>,
): Promise<ExportResult | undefined> {
  if (!task) return { kind: "detach" };
  const local = fieldsFor(task);
  if (!local) return { kind: "conflict" };
  if (deleteRevision !== undefined && (!options.exportEvents || task.revision !== deleteRevision))
    return { kind: "conflict" };
  const remote = await calendar.get(destination, link.remoteId);
  if (remote && !remote.fields && !remote.cancelled) return { kind: "conflict" };
  if (deleteRevision !== undefined) {
    if (
      remote?.fields &&
      (!remote.personal ||
        remote.ownerTag !== owner ||
        !link.base ||
        !sameFields(link.base, remote.fields))
    )
      return { kind: "conflict" };
    if (!(await beginDeletion?.(task.id, link.remoteId, deleteRevision)))
      return { kind: "conflict" };
    if (remote?.fields) await calendar.remove(destination, remote.id, remote.version);
    return { kind: "deleted" };
  }
  if (!remote || !remote.fields) {
    if (link.base || remote) return { kind: "detach" };
    if (!options.exportEvents) return;
    const created = await calendar.create(destination, link.remoteId, local, owner);
    if (!created.fields) return { kind: "conflict" };
    return { kind: "sync", fields: created.fields, apply: false, written: true };
  }
  if (!remote.personal || remote.ownerTag !== owner) return { kind: "conflict" };
  // After a lost create response only adopt an identical copy with our private marker.
  const merged = link.base
    ? mergeFields(link.base, local, remote.fields)
    : sameFields(local, remote.fields)
      ? local
      : null;
  if (!merged) return { kind: "conflict" };
  const write = !sameFields(merged, remote.fields),
    apply = !sameFields(merged, local);
  if ((write && !options.exportEvents) || (apply && !options.importEvents)) return;
  if (write) await calendar.update(destination, remote.id, remote.version, merged);
  return { kind: "sync", fields: merged, apply, written: write };
}
