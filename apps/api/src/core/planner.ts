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
	) {}

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
	create(input: CreateTask, rawInput?: string): Task {
		return this.db.transaction(() => {
			const { placement, id = crypto.randomUUID(), ...fields } = input;
			if (this.db.task(id)) throw new PlannerError(409, "Task ID already exists");
			const task = { id, ...fields, revision: this.db.revision() + 1 };
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
	update(id: string, patch: PatchTask) {
		return this.db.transaction(() => {
			const previous = this.get(id);
			if (patch.revision !== previous.revision)
				throw new PlannerError(409, "This task changed. Read the latest task before saving.");
			const updated = { ...previous, ...patch, revision: this.db.revision() + 1 };
			if (patch.parentId !== undefined) this.checkParent(id, updated.parentId);
			this.db.update(updated);
			this.db.advanceRevision();
			this.onTaskChanged?.(updated, previous);
			return updated;
		});
	}
	remove(id: string, expectedRevision?: number) {
		return this.db.transaction(() => {
			const parent = this.db.task(id);
			if (parent) {
				if (expectedRevision !== undefined && expectedRevision !== parent.revision)
					throw new PlannerError(409, "This task changed. Review the current task before deleting it.");
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
