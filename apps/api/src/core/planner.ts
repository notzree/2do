import { Temporal } from "@js-temporal/polyfill";
import { scheduleDay, shiftSchedule } from "./task-days.ts";
import type { TaskOutline } from "../extractors/subtasks.ts";
import { createTask } from "../interfaces/plan.ts";
import type { TaskTiming } from "../extractors/task-time.ts";
import type { PlannerDatabase } from "../interfaces/database.ts";
import type {
	CreateTask,
	Direction,
	Edge,
	PatchTask,
	Plan,
	PlanReader,
	Task,
	TaskSearch,
} from "../interfaces/plan.ts";

export class PlannerError extends Error {
	constructor(
		readonly status: 404 | 409,
		message: string,
	) {
		super(message);
	}
}

export class Planner implements PlanReader {
	constructor(
		private readonly db: PlannerDatabase,
		private readonly onTaskChanged?: (task: Task, previous?: Task, rawInput?: string) => void,
		readonly titleZone: (id?: string) => string = () => "UTC",
		private readonly beforeTaskRemoved?: (id: string) => void,
	) {}

	revision() { return this.db.revision(); }
	get(id: string): Task {
		const task = this.db.task(id);
		if (!task) throw new PlannerError(404, "Task not found");
		return task;
	}
	search(input: TaskSearch) {
		return this.db.search(input);
	}
	plan(): Plan {
		const tasks = this.db.tasks();
		const edges = this.db.edges();
		const successors = new Map<string, string[]>();
		const indegree = new Map(tasks.map((t) => [t.id, 0]));
		const byId = new Map(tasks.map((t) => [t.id, t]));
		for (const { from, to } of edges) {
			const children = successors.get(from) ?? [];
			children.push(to);
			successors.set(from, children);
			indegree.set(to, indegree.get(to)! + 1);
		}
		const ordered = tasks.filter((t) => indegree.get(t.id) === 0);
		for (const current of ordered) {
			for (const next of successors.get(current.id) ?? []) {
				const remaining = indegree.get(next)! - 1;
				indegree.set(next, remaining);
				if (remaining === 0) ordered.push(byId.get(next)!);
			}
		}
		if (ordered.length !== tasks.length) throw new Error("Stored plan contains a cycle");
		return { revision: this.db.revision(), tasks: ordered, edges };
	}
	traverse(id: string, direction: Direction) {
		this.get(id);
		return this.db.reachable(id, direction);
	}
	private checkParent(id: string, parentId: string | null) {
		let ancestor = parentId;
		while (ancestor) {
			if (ancestor === id) throw new PlannerError(409, "A task cannot contain itself");
			ancestor = this.get(ancestor).parentId;
		}
	}
	createOutline(input: CreateTask, outline?: TaskOutline, rawInput?: string, timing?: TaskTiming, capturedOn?: string) {
		if (!outline) return this.create(input, rawInput, timing, { capturedOn });
		return this.db.transaction(() => {
			const parent = this.create({ ...input, title: outline.title }, rawInput ?? input.title, timing, { capturedOn });
			for (const [siblingOrder, title] of outline.children.entries()) {
				this.create(createTask.parse({
					title, parentId: parent.id, completed: parent.completed,
					schedule: parent.currentDay ? { type: "day", date: parent.currentDay } : null,
					titleContext: input.titleContext,
				}), undefined, undefined, { siblingOrder, capturedOn: parent.createdDate });
			}
			return parent;
		});
	}
	create(input: CreateTask, rawInput?: string, timing: TaskTiming = {}, { siblingOrder, capturedOn }: { siblingOrder?: number; capturedOn?: string } = {}): Task {
		return this.db.transaction(() => {
			const { placement, titleContext: context, id = crypto.randomUUID(), ...fields } = input;
			if (this.db.task(id)) throw new PlannerError(409, "Task ID already exists");
			const zone = context?.timeZone ?? this.titleZone();
			const due = fields.due === undefined ? timing.due : fields.due;
			const defaultDay = !due && context?.defaultDate
				? { type: "day" as const, date: context.defaultDate }
				: null;
			const task: Task = {
				id,
				...fields,
				createdDate: capturedOn ?? Temporal.Now.plainDateISO(zone).toString(),
				...(siblingOrder !== undefined && { siblingOrder }),
				...(due !== undefined && { due }),
				schedule: fields.schedule === undefined ? timing.schedule ?? defaultDay : fields.schedule,
				durationMinutes: fields.durationMinutes === undefined ? timing.durationMinutes ?? null : fields.durationMinutes,
				revision: this.db.revision() + 1,
			};
			task.currentDay = scheduleDay(task.schedule, zone) ?? context?.defaultDate ?? null;
			this.checkParent(id, task.parentId);
			this.db.insert(task);
			if (placement) {
				const { anchor, side } = placement;
				if (anchor === id) throw new PlannerError(409, "A task cannot depend on itself");
				this.get(anchor);
				const before = side === "before";
				for (const neighbor of this.db.neighbors(anchor, before ? "ancestors" : "descendants")) {
					this.db.unlink(before ? { from: neighbor, to: anchor } : { from: anchor, to: neighbor });
					this.db.link(before ? { from: neighbor, to: id } : { from: id, to: neighbor });
				}
				this.db.link(before ? { from: id, to: anchor } : { from: anchor, to: id });
			}
			this.db.advanceRevision();
			this.onTaskChanged?.(task, undefined, rawInput);
			return task;
		});
	}
	update(id: string, patch: PatchTask, timing: TaskTiming = {}) {
		return this.db.transaction(() => {
			const previous = this.get(id);
			if (patch.revision !== previous.revision)
				throw new PlannerError(409, "This task changed. Read the latest task before saving.");
			const updated = { ...previous, ...patch, revision: this.db.revision() + 1 };
			if (patch.title && patch.title !== previous.title) {
				if (patch.due === undefined && !previous.due && timing.due) updated.due = timing.due;
				if (
					patch.schedule === undefined &&
					(!previous.schedule || previous.schedule.type === "day") &&
					timing.schedule
				)
					updated.schedule = timing.schedule;
				if (
					patch.durationMinutes === undefined &&
					previous.durationMinutes === null &&
					timing.durationMinutes
				)
					updated.durationMinutes = timing.durationMinutes;
			}
			if (updated.schedule !== previous.schedule)
				updated.currentDay = scheduleDay(updated.schedule, this.titleZone(id)) ?? null;
			if (patch.parentId !== undefined) this.checkParent(id, updated.parentId);
			this.db.update(updated);
			this.db.advanceRevision();
			this.onTaskChanged?.(updated, previous);
			return updated;
		});
	}
	carry(task: Task, from: string, to: string, zone: string, createdDate?: string) {
		const updated: Task = { ...task, currentDay: to, schedule: shiftSchedule(task.schedule, to, zone),
			createdDate: task.createdDate ?? createdDate, carriedFrom: [...(task.carriedFrom ?? []), from],
			revision: this.db.revision() + 1 };
		this.db.update(updated);
		this.db.advanceRevision();
		this.onTaskChanged?.(updated, task);
	}
	remove(id: string, expectedRevision?: number) {
		return this.db.transaction(() => {
			const parent = this.db.task(id);
			if (parent) {
				this.beforeTaskRemoved?.(id);
				if (expectedRevision !== undefined && expectedRevision !== parent.revision)
					throw new PlannerError(
						409,
						"This task changed. Review the current task before deleting it.",
					);
				const revision = this.db.revision() + 1;
				for (const child of this.db.children(id)) {
					const updated = { ...child, parentId: parent.parentId, revision };
					this.db.update(updated);
					this.onTaskChanged?.(updated, child);
				}
				this.db.advanceRevision();
			}
			const receipt = this.db.remove(id);
			if (!parent && !receipt.pages.length) throw new PlannerError(404, "Task not found");
			return receipt;
		});
	}
	setDependency(edge: Edge, present: boolean, expectedRevision?: number) {
		this.db.transaction(() => {
			this.get(edge.from);
			this.get(edge.to);
			if (
				present &&
				(edge.from === edge.to || this.db.reachable(edge.to, "descendants").includes(edge.from))
			) {
				throw new PlannerError(409, "This dependency would create a cycle");
			}
			const changed = present ? this.db.link(edge) : this.db.unlink(edge);
			if (!changed) return;
			if (expectedRevision !== undefined && expectedRevision !== this.db.revision())
				throw new PlannerError(409, "The plan changed. Review its dependencies before saving.");
			this.db.advanceRevision();
		});
	}
}
