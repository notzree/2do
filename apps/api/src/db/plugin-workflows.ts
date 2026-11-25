import { and, eq, inArray, isNotNull, lt, lte, min } from "drizzle-orm";
import type { PlannerStore } from "./planner.ts";
import { ownsImage } from "./planner-images.ts";
import { subtypes, workflowJobs, workflowReceipts, workflowStates } from "./schema.ts";

export type EffectJob = typeof workflowJobs.$inferSelect;
type SourceTable = typeof workflowJobs | typeof workflowStates;
function source(table: SourceTable, taskId: string, typeId: string) {
  return and(eq(table.taskId, taskId), eq(table.typeId, typeId));
}
export class WorkflowDatabase {
  constructor(private readonly db: PlannerStore) {}
  ownsImage(id: string) {
    return ownsImage(this.db, id);
  }
  state(taskId: string, typeId: string) {
    return this.db
      .select()
      .from(workflowStates)
      .where(source(workflowStates, taskId, typeId))
      .get();
  }
  putState(row: typeof workflowStates.$inferInsert) {
    this.db
      .insert(workflowStates)
      .values(row)
      .onConflictDoUpdate({
        target: [workflowStates.taskId, workflowStates.typeId],
        set: row,
      })
      .run();
  }
  forget(taskId: string, typeId: string) {
    this.cancel(taskId, typeId);
    this.db
      .delete(workflowStates)
      .where(source(workflowStates, taskId, typeId))
      .run();
  }
  suspended(typeId: string) {
    return this.db
      .select()
      .from(workflowStates)
      .where(and(eq(workflowStates.typeId, typeId), isNotNull(workflowStates.suspendedChanges)))
      .all();
  }
  receipt(commandId: string) {
    return this.db
      .select()
      .from(workflowReceipts)
      .where(eq(workflowReceipts.commandId, commandId))
      .get();
  }
  saveReceipt(row: typeof workflowReceipts.$inferInsert) {
    this.db.insert(workflowReceipts).values(row).run();
  }
  enqueue(row: EffectJob) {
    this.db
      .insert(workflowJobs)
      .values(row)
      .onConflictDoUpdate({
        target: [workflowJobs.taskId, workflowJobs.typeId],
        set: row,
      })
      .run();
  }
  job(taskId: string, typeId: string) {
    return this.db
      .select()
      .from(workflowJobs)
      .where(source(workflowJobs, taskId, typeId))
      .get();
  }
  cancel(taskId: string, typeId: string) {
    this.db
      .delete(workflowJobs)
      .where(source(workflowJobs, taskId, typeId))
      .run();
  }
  cancelTypes(typeIds: string[]) {
    this.db.delete(workflowJobs).where(inArray(workflowJobs.typeId, typeIds)).run();
  }
  nextDue() {
    return this.db
      .select({ due: min(workflowJobs.due) })
      .from(workflowJobs)
      .get()!.due;
  }
  claim(now: number, leaseUntil: number) {
    const due = this.db
      .select()
      .from(workflowJobs)
      .where(lte(workflowJobs.due, now))
      .orderBy(workflowJobs.due, workflowJobs.taskId, workflowJobs.typeId)
      // A vision request expands an 8 MiB attachment into a model payload.
      // Claim one effect per wake so several uploads cannot exhaust one planner's memory.
      .limit(1)
      .all();
    return due.map((job) => {
      const attempts = job.attempts + 1;
      this.db
        .update(workflowJobs)
        .set({ due: leaseUntil, attempts })
        .where(eq(workflowJobs.token, job.token))
        .run();
      return { ...job, attempts };
    });
  }
  retry(job: EffectJob, due: number) {
    this.db
      .update(workflowJobs)
      .set({ due })
      .where(and(eq(workflowJobs.token, job.token), eq(workflowJobs.attempts, job.attempts)))
      .run();
  }
  olderSubtypes(typeId: string, version: number) {
    return this.db
      .select()
      .from(subtypes)
      .where(and(eq(subtypes.typeId, typeId), lt(subtypes.schemaVersion, version)))
      .all();
  }
  olderStates(typeId: string, version: number) {
    return this.db
      .select()
      .from(workflowStates)
      .where(and(eq(workflowStates.typeId, typeId), lt(workflowStates.version, version)))
      .all();
  }
}
