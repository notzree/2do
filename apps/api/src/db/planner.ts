import { and, eq, gt, or, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { PlannerDatabase } from "../interfaces/database.ts";
import { withoutTaskReferences, type DeleteTaskReceipt } from "../interfaces/notebook.ts";
import { task, type Direction, type Edge, type Task, type TaskSearch } from "../interfaces/plan.ts";
import { days, dependency, planHead, tasks } from "./schema.ts";

export type PlannerStore = DrizzleSqliteDODatabase;

export class SqlitePlannerDatabase implements PlannerDatabase {
	constructor(private readonly db: PlannerStore) {}

	transaction<T>(write: () => T): T {
		return this.db.transaction(write);
	}
	revision() {
		return this.db.select().from(planHead).get()!.revision;
	}
	advanceRevision() {
		this.db
			.update(planHead)
			.set({ revision: sql`${planHead.revision} + 1` })
			.run();
	}
	tasks() {
		return this.db
			.select()
			.from(tasks)
			.orderBy(tasks.id)
			.all()
			.map((row) => task.parse(row.document));
	}
	children(id: string) {
		return this.db
			.select({ document: tasks.document })
			.from(tasks)
			.where(eq(tasks.parentId, id))
			.all()
			.map((row) => task.parse(row.document));
	}
	search({ title, completed, date, interval, after, limit }: TaskSearch) {
		const doc = tasks.document;
		const rows = this.db
			.select({ document: doc })
			.from(tasks)
			.where(
				and(
					after === undefined ? undefined : gt(tasks.id, after),
					title === undefined
						? undefined
						: sql`instr(lower(json_extract(${doc}, '$.title')), lower(${title})) > 0`,
					completed === undefined
						? undefined
						: sql`json_extract(${doc}, '$.completed') = ${Number(completed)}`,
					or(
						date === undefined ? undefined : sql`((json_extract(${doc}, '$.schedule') IS NULL AND json_extract(${doc}, '$.currentDay') = ${date}) OR json_extract(${doc}, '$.due.date') = ${date} OR json_extract(${doc}, '$.schedule.date') = ${date} OR (json_extract(${doc}, '$.schedule.date') < ${date} AND json_extract(${doc}, '$.schedule.endDateExclusive') > ${date}))`,
						interval && sql`julianday(json_extract(${doc}, '$.due.at')) >= julianday(${interval.start}) AND julianday(json_extract(${doc}, '$.due.at')) < julianday(${interval.end})`,
						interval &&
							sql`julianday(json_extract(${doc}, '$.schedule.start')) < julianday(${interval.end})
					AND julianday(json_extract(${doc}, '$.schedule.end')) > julianday(${interval.start})`,
					),
				),
			)
			.orderBy(tasks.id)
			.limit(limit + 1)
			.all();
		const page = rows.slice(0, limit).map((row) => task.parse(row.document));
		return { tasks: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
	}
	task(id: string) {
		const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
		return row && task.parse(row.document);
	}
	insert(document: Task) {
		this.db.insert(tasks).values({ id: document.id, document }).run();
	}
	update(document: Task) {
		this.db.update(tasks).set({ document }).where(eq(tasks.id, document.id)).run();
	}
	remove(id: string): DeleteTaskReceipt {
		// Keep only dates in memory; a day document can contain thousands of blocks.
		const candidates = this.db
			.select({ date: days.day })
			.from(days)
			.where(sql`exists (
			select 1 from json_each(${days.document}, '$.content') as block
			where json_extract(block.value, '$.type') IN ('taskRef', 'graphRef') AND json_extract(block.value, '$.attrs.id') = ${id}
		)`)
			.orderBy(days.day)
			.all();
		const pages: DeleteTaskReceipt["pages"] = [];
		for (const { date } of candidates) {
			const current = this.db.select().from(days).where(eq(days.day, date)).get()!;
			const document = withoutTaskReferences(current.document, id);
			if (document === current.document) continue;
			const revision = current.revision + 1;
			// Only a notebook save has a SHA-256 command hash eligible for replay.
			this.db
				.update(days)
				.set({ document, revision, commandHash: "" })
				.where(eq(days.day, date))
				.run();
			pages.push({ date, previousRevision: current.revision, revision });
		}
		this.db.delete(tasks).where(eq(tasks.id, id)).run();
		return { pages };
	}
	edges() {
		return this.db
			.select({ from: dependency.prerequisite, to: dependency.dependent })
			.from(dependency)
			.orderBy(dependency.prerequisite, dependency.dependent)
			.all();
	}
	private columns(direction: Direction) {
		return direction === "descendants"
			? ([dependency.prerequisite, dependency.dependent] as const)
			: ([dependency.dependent, dependency.prerequisite] as const);
	}
	neighbors(id: string, direction: Direction) {
		const [source, target] = this.columns(direction);
		return this.db
			.select({ id: target })
			.from(dependency)
			.where(eq(source, id))
			.orderBy(target)
			.all()
			.map((row) => row.id);
	}
	reachable(id: string, direction: Direction) {
		const [source, target] = this.columns(direction);
		return this.db
			.all<{ id: string }>(sql`WITH RECURSIVE walk(id) AS (
			SELECT ${target} FROM ${dependency} WHERE ${source} = ${id}
			UNION SELECT ${target} FROM ${dependency} JOIN walk ON ${source} = walk.id
		) SELECT id FROM walk ORDER BY id`)
			.map((row) => row.id);
	}
	link({ from, to }: Edge) {
		return !!this.db
			.insert(dependency)
			.values({ prerequisite: from, dependent: to })
			.onConflictDoNothing()
			.returning()
			.get();
	}
	unlink({ from, to }: Edge) {
		return !!this.db
			.delete(dependency)
			.where(and(eq(dependency.prerequisite, from), eq(dependency.dependent, to)))
			.returning()
			.get();
	}
}
