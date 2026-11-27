// This module is shared by clients, the planner, and future plugins. Keep it runtime-neutral.
import { z } from "zod";

export const taskId = z.uuid();
export const kind = z.enum(["task", "event", "milestone"]);
const interval = {
	start: z.iso.datetime({ offset: true }),
	end: z.iso.datetime({ offset: true }),
};
export const fixedSchedule = z.strictObject({ type: z.literal("fixed"), ...interval })
	.refine((s) => Date.parse(s.end) > Date.parse(s.start), {
		message: "The end of an interval must follow its start.",
	});
export const daySchedule = z.strictObject({ type: z.literal("day"), date: z.iso.date(), endDateExclusive: z.iso.date().optional() })
	.refine(s => !s.endDateExclusive || s.endDateExclusive > s.date, { message: "All-day end must follow its start." });
export const schedule = z
	.discriminatedUnion("type", [
		daySchedule,
		fixedSchedule,
		z.strictObject({ type: z.literal("window"), ...interval }),
	])
	.refine((s) => s.type === "day" || Date.parse(s.end) > Date.parse(s.start), {
		message: "The end of an interval must follow its start.",
	})
	.describe("An all-day date or a half-open interval with end later than start.");
export const dueDate = z.discriminatedUnion("type", [
	z.strictObject({type:z.literal("day"),date:z.iso.date()}),
	z.strictObject({type:z.literal("time"),at:z.iso.datetime({offset:true}),timeZone:z.string().min(1).refine(zone=>{try{new Intl.DateTimeFormat("en",{timeZone:zone});return true}catch{return false}})}),
]);
const fields = {
	due: dueDate.nullable().optional(),
	parentId: taskId.nullable(),
	title: z.string().trim().min(1).max(240),
	kind,
	completed: z.boolean(),
	schedule: schedule.nullable(),
	durationMinutes: z.int().positive().max(525600).nullable(),
};
const revision = z.int().nonnegative();
const siblingIds = z.array(taskId).min(1).max(500).refine(ids=>new Set(ids).size===ids.length,"Duplicate child");
export const siblingOrderChange = z.strictObject({before:siblingIds,after:siblingIds});
export const task = z.strictObject({
	id: taskId,
	createdDate: z.iso.date().optional().describe("Local creation date, when known."),
	currentDay: z.iso.date().nullable().optional().describe("Current planner day; null for an unassigned task."),
	carriedFrom: z.array(z.iso.date()).optional().describe("Previous planner days, one per carryover."),
	siblingOrder: z.int().nonnegative().optional(),
	revision,
	...fields,
});
export const placement = z.strictObject({ side: z.enum(["before", "after"]), anchor: taskId });
export const timeZone = z
	.string()
	.min(1)
	.max(100)
	.refine((zone) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: zone });
			return true;
		} catch {
			return false;
		}
	}, "Unknown time zone");
export const titleContext = z.strictObject({
	timeZone: timeZone.optional(),
	defaultDate: z.iso.date().optional(),
	referenceDate: z.iso.date().optional(),
});
export const createTask = z.strictObject({
	...fields,
	parentId: fields.parentId.default(null),
	id: taskId.optional().describe("Client-assigned ID. Reusing an existing ID returns 409."),
	kind: kind.default("task"),
	completed: fields.completed.default(false),
	schedule: fields.schedule.optional(),
	durationMinutes: fields.durationMinutes.optional(),
	placement: placement.optional(),
	titleContext: titleContext.optional().describe("Calendar context for dates and times in the title."),
});
export const patchTask = z
	.strictObject(fields)
	.partial()
	.extend({ revision: revision.describe("Task revision from the most recent read") })
	.refine((p) => Object.keys(p).length > 1, {
		message: "Provide at least one field to update.",
	})
	.meta({ minProperties: 2 });

export const taskSearch = z.strictObject({
	title: z.string().trim().min(1).max(240).optional(),
	completed: z.boolean().optional(),
	date: z.iso
		.date()
		.optional()
		.describe(
			"Match floating tasks on this calendar day. Combine with an interval to also match timed commitments.",
		),
	interval: z
		.strictObject(interval)
		.refine((s) => Date.parse(s.end) > Date.parse(s.start))
		.optional()
		.describe(
			"Match fixed times and windows overlapping this half-open interval. Use the local midnight offsets for a calendar day.",
		),
	after: taskId.optional().describe("Cursor from the previous result"),
	limit: z.int().min(1).max(50).default(20),
});
export const taskSearchResult = z.strictObject({
	tasks: z.array(task),
	nextCursor: taskId.nullable(),
});
export type TaskSearch = z.infer<typeof taskSearch>;
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
