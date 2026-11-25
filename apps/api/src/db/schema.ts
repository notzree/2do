import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Task } from "../interfaces/plan.ts";
import type { TimeProposal } from "../interfaces/review.ts";
import type { NotebookDoc, TaskCapture } from "../interfaces/notebook.ts";
import type { TaskSubtype } from "../interfaces/task-plugins.ts";

export const planHead = sqliteTable(
	"plan_head",
	{
		singleton: integer().primaryKey(),
		revision: integer().notNull(),
	},
	(t) => [check("singleton_one", sql`${t.singleton} = 1`)],
);

export const tasks = sqliteTable(
	"task",
	{
		id: text().primaryKey(),
		document: text({ mode: "json" }).$type<Task>().notNull(),
		parentId: text().generatedAlwaysAs(sql`json_extract(document, '$.parentId')`),
	},
	(t) => [index("task_parent").on(t.parentId)],
);
const taskReference = () =>
	text()
		.notNull()
		.references(() => tasks.id, { onDelete: "cascade" });
export const taskCaptures = sqliteTable("task_capture", {
	taskId: taskReference().primaryKey(),
	document: text({ mode: "json" }).$type<TaskCapture>().notNull(),
	// Older captures have no edit history proving the original still represents the current title.
	currentInput: integer({ mode: "boolean" }).notNull().default(false),
});
export const dependency = sqliteTable(
	"dependency",
	{
		prerequisite: taskReference(),
		dependent: taskReference(),
	},
	(t) => [
		primaryKey({ columns: [t.prerequisite, t.dependent] }),
		check("distinct_tasks", sql`${t.prerequisite} <> ${t.dependent}`),
		index("by_dependent").on(t.dependent, t.prerequisite),
	],
);

export const installations = sqliteTable("task_plugin_install", {
	id: text().primaryKey(),
	epoch: text().notNull(),
});
export const subtypes = sqliteTable(
	"task_subtype",
	{
		taskId: taskReference(),
		typeId: text().notNull(),
		schemaVersion: integer().notNull(),
		revision: text().notNull(),
		classifiedTitle: text(),
		source: text().$type<TaskSubtype["source"]>().notNull(),
		document: text({ mode: "json" }).$type<TaskSubtype["data"]>(),
	},
	(t) => [primaryKey({ columns: [t.taskId, t.typeId] })],
);
export const jobs = sqliteTable(
	"task_classification",
	{
		taskId: taskReference().primaryKey(),
		token: text().notNull(),
		rawInput: text(),
		due: integer(),
		attempts: integer().notNull().default(0),
	},
	(t) => [index("task_classification_due").on(t.due)],
);

export const days = sqliteTable("day_page", {
	day: text().primaryKey(),
	commandHash: text().notNull(),
	revision: integer().notNull(),
	document: text({ mode: "json" }).$type<NotebookDoc>().notNull(),
});
export const images = sqliteTable("notebook_image", { id: text().primaryKey() });
export const sideChats = sqliteTable("side_chat", {
	id: text().primaryKey(),
	title: text().notNull(),
	createdAt: integer().notNull(),
});

export const taskPromptSkips = sqliteTable(
	"task_prompt_skip",
	{ taskId: taskReference(), promptId: text().notNull() },
	(t) => [primaryKey({ columns: [t.taskId, t.promptId] })],
);

export const classificationResults = sqliteTable("task_classification_result", {
	taskId: taskReference().primaryKey(),
	checkedAt: text().notNull(),
	title: text().notNull(),
	decisions: text({ mode: "json" })
		.$type<{ typeId: string; epoch: string; matched: boolean }[]>()
		.notNull(),
});

export const timeProposals = sqliteTable(
	"time_proposal",
	{
		id: text().primaryKey(),
		taskId: taskReference(),
		status: text().$type<TimeProposal["status"] | "duplicate">().notNull(),
		document: text({ mode: "json" })
			.$type<Omit<TimeProposal, "id" | "taskId" | "status"> & { canonicalId?: string }>()
			.notNull(),
	},
	(t) => [index("time_proposal_pending").on(t.status, t.taskId)],
);
