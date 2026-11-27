import { and, eq, lte, min, ne, or } from "drizzle-orm";
import type { PlannerStore } from "./planner.ts";
import { extractionJobs as jobs } from "./schema.ts";

export type ExtractionJob = typeof jobs.$inferSelect;
const lease = (job: ExtractionJob) =>
  and(
    eq(jobs.taskId, job.taskId),
    eq(jobs.typeId, job.typeId),
    eq(jobs.revision, job.revision),
    eq(jobs.epoch, job.epoch),
    eq(jobs.attempts, job.attempts),
  );

export class ExtractionQueue {
  constructor(private readonly db: PlannerStore) {}
  enqueue(job: ExtractionJob) {
    this.db
      .insert(jobs)
      .values(job)
      .onConflictDoUpdate({
        target: [jobs.taskId, jobs.typeId],
        set: job,
        setWhere: or(ne(jobs.revision, job.revision), ne(jobs.epoch, job.epoch)),
      })
      .run();
  }
  cancelTask(id: string) {
    this.db.delete(jobs).where(eq(jobs.taskId, id)).run();
  }
  nextDue() {
    return this.db
      .select({ due: min(jobs.due) })
      .from(jobs)
      .get()!.due;
  }
  claimDue(now: number, leaseMs: number, limit: number) {
    const ready = this.db
      .select()
      .from(jobs)
      .where(lte(jobs.due, now))
      .orderBy(jobs.due, jobs.taskId, jobs.typeId)
      .limit(limit)
      .all();
    return ready.map((job) => {
      const claimed = { attempts: job.attempts + 1, due: now + leaseMs };
      this.db.update(jobs).set(claimed).where(lease(job)).run();
      return { ...job, ...claimed };
    });
  }
  finish(job: ExtractionJob) {
    return this.db.delete(jobs).where(lease(job)).returning({ id: jobs.taskId }).get();
  }
  retry(job: ExtractionJob) {
    this.db
      .update(jobs)
      .set({ due: Date.now() + 2000 * job.attempts })
      .where(lease(job))
      .run();
  }
}
