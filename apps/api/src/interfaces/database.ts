import type { Direction, Edge, Task, TaskSearch } from "./plan.ts";
import type { DeleteTaskReceipt } from "./notebook.ts";

export type CommitTaskWrite = <T>(write: () => T) => Promise<T>;

/** Synchronous on purpose: validation and all related edits share one SQLite transaction. */
export interface PlannerDatabase {
	transaction<T>(write: () => T): T;
	revision(): number;
	advanceRevision(): void;
	tasks(): Task[];
	children(id: string): Task[];
	search(input: TaskSearch): { tasks: Task[]; nextCursor: string | null };
	task(id: string): Task | undefined;
	insert(task: Task): void;
	update(task: Task): void;
	remove(id: string): DeleteTaskReceipt;
	edges(): Edge[];
	neighbors(id: string, direction: Direction): string[];
	reachable(id: string, direction: Direction): string[];
	link(edge: Edge): boolean;
	unlink(edge: Edge): boolean;
}
