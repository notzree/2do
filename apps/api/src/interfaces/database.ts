import type { Direction, Edge, Task } from "./plan.ts";

/** Synchronous on purpose: validation and all related edits share one SQLite transaction. */
export interface PlannerDatabase {
	transaction<T>(write: () => T): T;
	revision(): number;
	advanceRevision(): void;
	tasks(): Task[];
	task(id: string): Task | undefined;
	insert(task: Task): void;
	update(task: Task): void;
	remove(id: string): void;
	edges(): Edge[];
	neighbors(id: string, direction: Direction): string[];
	reachable(id: string, direction: Direction): string[];
	link(edge: Edge): boolean;
	unlink(edge: Edge): boolean;
}
