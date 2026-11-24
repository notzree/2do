// This module is shared by clients, the planner, and future plugins. Keep it runtime-neutral.
import { z } from "zod";

export const taskId = z.uuid();
export const kind = z.enum(["task", "event", "meal", "milestone"]);
const interval = {
	start: z.iso.datetime({ offset: true }),
	end: z.iso.datetime({ offset: true }),
};
export const schedule = z
	.discriminatedUnion("type", [
		z.strictObject({ type: z.literal("day"), date: z.iso.date() }),
		z.strictObject({ type: z.literal("fixed"), ...interval }),
		z.strictObject({ type: z.literal("window"), ...interval }),
	])
	.refine((s) => s.type === "day" || Date.parse(s.end) > Date.parse(s.start), {
		message: "The end of an interval must follow its start.",
	})
	.describe("An all-day date or a half-open interval with end later than start.");
const fields = {
	parentId: taskId.nullable(),
	title: z.string().trim().min(1).max(240),
	kind,
	completed: z.boolean(),
	schedule: schedule.nullable(),
	durationMinutes: z.int().positive().max(525600).nullable(),
};
export const task = z.strictObject({
	id: taskId,
	...fields,
	parentId: fields.parentId.default(null),
});
export const placement = z.strictObject({ side: z.enum(["before", "after"]), anchor: taskId });
export const createTask = z.strictObject({
	...fields,
	parentId: fields.parentId.default(null),
	id: taskId.optional().describe("Client-assigned ID. Reusing an existing ID returns 409."),
	kind: kind.default("task"),
	completed: fields.completed.default(false),
	schedule: fields.schedule.default(null),
	durationMinutes: fields.durationMinutes.default(null),
	placement: placement.optional(),
});
export const patchTask = z
	.strictObject(fields)
	.partial()
	.refine((p) => Object.keys(p).length > 0, {
		message: "Provide at least one field to update.",
	})
	.meta({ minProperties: 1 });
export const edge = z
	.strictObject({ from: taskId, to: taskId })
	.describe("from must finish before to starts");
export const plan = z.strictObject({
	revision: z.int().nonnegative(),
	tasks: z.array(task),
	edges: z.array(edge),
});
export const direction = z.enum(["ancestors", "descendants"]);
export type Task = z.infer<typeof task>;
export type TaskKind = z.infer<typeof kind>;
export type CreateTask = z.infer<typeof createTask>;
export type PatchTask = z.infer<typeof patchTask>;
export type Edge = z.infer<typeof edge>;
export type Plan = z.infer<typeof plan>;
export type Direction = z.infer<typeof direction>;

/** Read surface shared with in-process consumers. Mutations belong to the planner. */
export interface PlanReader {
	get(id: string): Task;
	plan(): Plan;
	traverse(id: string, direction: Direction): string[];
}
