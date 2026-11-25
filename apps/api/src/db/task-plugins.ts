import { and, eq, gte, isNotNull, lte, min, or, sql } from "drizzle-orm";
import { taskSubtype, type TaskSubtype } from "../interfaces/task-plugins.ts";
import type { PlannerStore } from "./planner.ts";
import {
	classificationResults,
	installations,
	jobs,
	subtypes,
	taskCaptures,
	tasks,
} from "./schema.ts";

export type ClassificationJob = Pick<
	typeof jobs.$inferSelect,
	"taskId" | "token" | "attempts" | "rawInput"
>;
function lease(job: ClassificationJob) {
	return and(
		eq(jobs.taskId, job.taskId),
		eq(jobs.token, job.token),
		eq(jobs.attempts, job.attempts),
	);
}

export class SqliteTaskPluginDatabase {
	constructor(private readonly db: PlannerStore) {}

	installations() {
		return new Map(
			this.db
				.select()
				.from(installations)
				.all()
				.map(({ id, epoch }) => [id, epoch]),
		);
	}
	setEnabled(id: string, enabled: boolean) {
		return enabled
			? !!this.db
					.insert(installations)
					.values({ id, epoch: crypto.randomUUID() })
					.onConflictDoNothing()
					.returning()
					.get()
			: !!this.db.delete(installations).where(eq(installations.id, id)).returning().get();
	}
	staleAutomatic(typeId: string) {
		return this.db
			.select({ id: subtypes.taskId })
			.from(subtypes)
			.innerJoin(tasks, eq(tasks.id, subtypes.taskId))
			.where(
				and(
					eq(subtypes.typeId, typeId),
					eq(subtypes.source, "automatic"),
					sql`${subtypes.classifiedTitle} IS NOT json_extract(${tasks.document}, '$.title')`,
				),
			)
			.all()
			.map((row) => row.id);
	}
	subtypes(taskId: string, title: string): TaskSubtype[] {
		return this.db
			.select()
			.from(subtypes)
			.where(
				and(
					eq(subtypes.taskId, taskId),
					or(eq(subtypes.source, "manual"), eq(subtypes.classifiedTitle, title)),
				),
			)
			.orderBy(subtypes.typeId)
			.all()
			.map(({ taskId: _, classifiedTitle: _title, document, ...row }) =>
				taskSubtype.parse({ ...row, data: document }),
			);
	}
	putSubtype(
		taskId: string,
		{ typeId, data, ...fields }: TaskSubtype,
		classifiedTitle: string | null,
	) {
		const changes = { ...fields, document: data, classifiedTitle };
		this.db
			.insert(subtypes)
			.values({ taskId, typeId, ...changes })
			.onConflictDoUpdate({
				target: [subtypes.taskId, subtypes.typeId],
				set: changes,
			})
			.run();
	}
	removeAutomatic(taskId: string, typeId: string) {
		this.db
			.delete(subtypes)
			.where(
				and(
					eq(subtypes.taskId, taskId),
					eq(subtypes.typeId, typeId),
					eq(subtypes.source, "automatic"),
				),
			)
			.run();
	}
	enqueue(taskId: string, due: number, rawInput?: string) {
		const changes = { token: crypto.randomUUID(), due, attempts: 0, rawInput: rawInput ?? null };
		this.db
			.insert(jobs)
			.values({ taskId, ...changes })
			.onConflictDoUpdate({ target: jobs.taskId, set: changes })
			.run();
	}
	supersedeCaptureInput(taskId: string, now = Date.now()) {
		// Give the rename a fresh lease and retry budget if a capture job already exists.
		this.db
			.update(jobs)
			.set({ token: crypto.randomUUID(), due: now, attempts: 0, rawInput: null })
			.where(and(eq(jobs.taskId, taskId), isNotNull(jobs.rawInput)))
			.run();
	}
	classification(taskId: string) {
		const job = this.db.select({ due: jobs.due }).from(jobs).where(eq(jobs.taskId, taskId)).get();
		return !job ? "idle" : job.due === null ? "failed" : "pending";
	}
	requestClassification(taskId: string, due: number) {
		// An active lease already represents this request. A failed lease retains its capture input.
		const capture = this.db
			.select({ document: taskCaptures.document })
			.from(taskCaptures)
			.where(and(eq(taskCaptures.taskId, taskId), eq(taskCaptures.currentInput, true)))
			.get();
		this.db
			.insert(jobs)
			.values({ taskId, due, token: crypto.randomUUID(), rawInput: capture?.document.rawInput })
			.onConflictDoUpdate({
				target: jobs.taskId,
				set: { due, token: crypto.randomUUID(), attempts: 0 },
				setWhere: sql`${jobs.due} IS NULL`,
			})
			.run();
	}
	saveResult(result: typeof classificationResults.$inferInsert) {
		this.db
			.insert(classificationResults)
			.values(result)
			.onConflictDoUpdate({ target: classificationResults.taskId, set: result })
			.run();
	}
	lastResult(taskId: string, title: string, epochs: ReadonlyMap<string, string>) {
		const result = this.db
			.select()
			.from(classificationResults)
			.where(and(eq(classificationResults.taskId, taskId), eq(classificationResults.title, title)))
			.get();
		const decisions = result?.decisions.filter((d) => epochs.get(d.typeId) === d.epoch);
		if (!result || !decisions?.length) return;
		return {
			checkedAt: result.checkedAt,
			evaluated: decisions.map((d) => d.typeId),
			matched: decisions.filter((d) => d.matched).map((d) => d.typeId),
		};
	}
	nextDue() {
		return this.db
			.select({ due: min(jobs.due) })
			.from(jobs)
			.get()!.due;
	}
	claimDue(now: number, limit: number, leaseUntil: number, maxAttempts: number) {
		this.db
			.update(jobs)
			.set({ due: null })
			.where(and(lte(jobs.due, now), gte(jobs.attempts, maxAttempts)))
			.run();
		return this.db
			.select({
				taskId: jobs.taskId,
				token: jobs.token,
				attempts: jobs.attempts,
				rawInput: jobs.rawInput,
			})
			.from(jobs)
			.where(lte(jobs.due, now))
			.orderBy(jobs.due, jobs.taskId)
			.limit(limit)
			.all()
			.map((job) => {
				const attempts = job.attempts + 1;
				this.db
					.update(jobs)
					.set({ due: leaseUntil, attempts })
					.where(eq(jobs.taskId, job.taskId))
					.run();
				return { ...job, attempts };
			});
	}
	finish(job: ClassificationJob) {
		return !!this.db
			.delete(jobs)
			.where(and(lease(job), isNotNull(jobs.due)))
			.returning()
			.get();
	}
	retry(job: ClassificationJob, due: number | null) {
		this.db
			.update(jobs)
			.set({ due })
			.where(and(lease(job), isNotNull(jobs.due)))
			.run();
	}
}
