import { sql } from "drizzle-orm";
import { check, index, integer, uniqueIndex, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Task } from "../interfaces/plan.ts";
import type { TimeProposal } from "../interfaces/review.ts";
import type { NotebookDoc, TaskCapture } from "../interfaces/notebook.ts";
import type { TaskSubtype } from "../interfaces/task-plugins.ts";
import type { PluginData } from "../interfaces/plugin-workflows.ts";
export * from "./report-schema.ts";

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
	archivedAt: integer(),
	branch: text({ mode: "json" }).$type<{ messageId: string; excerpt: string; generation?:string }>(),
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

export const workflowStates = sqliteTable(
	"plugin_workflow",
	{
		taskId: taskReference(),
		typeId: text().notNull(),
		version: integer().notNull(),
		revision: text().notNull(),
		document: text({ mode: "json" }).$type<PluginData>().notNull(),
		suspendedChanges: text({ mode: "json" }).$type<string[]>(),
	},
	(t) => [primaryKey({ columns: [t.taskId, t.typeId] })],
);

export const workflowReceipts = sqliteTable("plugin_command_receipt", {
	commandId: text().primaryKey(),
	taskId: taskReference(),
	signature: text().notNull(),
	workflowRevision: text().notNull(),
});

export const workflowJobs = sqliteTable(
	"plugin_effect",
	{
		taskId: taskReference(),
		typeId: text().notNull(),
		effect: text().notNull(),
		token: text().notNull(),
		epoch: text().notNull(),
		subtypeRevision: text().notNull(),
		workflowRevision: text().notNull(),
		input: text({ mode: "json" }).$type<PluginData>().notNull(),
		due: integer().notNull(),
		attempts: integer().notNull(),
	},
	(t) => [primaryKey({ columns: [t.taskId, t.typeId] }), index("plugin_effect_due").on(t.due)],
);

export const extractionJobs = sqliteTable(
	"subtype_extraction",
	{
		taskId: taskReference(),
		typeId: text().notNull(),
		epoch: text().notNull(),
		revision: text().notNull(),
		title: text().notNull(),
		input: text({ mode: "json" }).$type<{ text: string; workflowRevision?: string }>().notNull(),
		due: integer().notNull(),
		attempts: integer().notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.taskId, t.typeId] }), index("subtype_extraction_due").on(t.due)],
);

export const calendarLinks = sqliteTable("calendar_link", {
	taskId: text().primaryKey(),
	account: text().notNull(),
	remoteId: text().notNull(),
	origin: text({ enum: ["google", "planner"] }).notNull(),
	base: text({ mode: "json" }).$type<import("../interfaces/connectors.ts").EventFields>(),
	conflict: integer({ mode: "boolean" }).notNull().default(false),
	seen: text(),
}, t => [uniqueIndex("calendar_remote").on(t.account, t.origin, t.remoteId)]);

export const plannerGoals = sqliteTable("planner_goal", {
	id: text().primaryKey(), revision: text().notNull(), creation: text().notNull(),
	document: text({ mode: "json" }).$type<import("../interfaces/goals.ts").GoalRecord>().notNull(),
});
export const goalLinks = sqliteTable("goal_task_link", {
	goalId: text().notNull().references(() => plannerGoals.id, { onDelete: "cascade" }),
	taskId: taskReference(), role: text().$type<"contributes" | "satisfies">().notNull(),
}, (t) => [primaryKey({ columns: [t.goalId, t.taskId] }), index("goals_by_task").on(t.taskId)]);
export const goalCheckIns = sqliteTable("goal_check_in", {
	id: integer().primaryKey(), goalId: text().notNull().references(() => plannerGoals.id, { onDelete: "cascade" }),
	at: text().notNull(), note: text().notNull(),
}, (t) => [index("check_ins_by_goal").on(t.goalId, t.id)]);

export type InboxCommand = {
  captureDate?: string;
	operation: string; args: Record<string, unknown>; url?: string; method?: string;
	effects?: import("../interfaces/agent-inbox.ts").InboxEffect[]; steps?: InboxCommand[];
};
export type InboxDocument = {
	taskTitles?: Record<string, string>;
	deviceCallId?:string;
	title: string; body: string; choices?: string[];
	changes?: import("../interfaces/agent-inbox.ts").InboxChange[];
	conversation?: string; taskId?: string; reminderId?: string; source?: string; answer?: string; expiresAt?:string;
	elicitation?:import("../interfaces/elicitation.ts").ElicitationView;
	continuation?:import("../interfaces/elicitation.ts").McpContinuation;
	nextItemId?:string; providerAnswer?:import("../interfaces/elicitation.ts").ElicitationReply;
	command?: InboxCommand; authorization?: string; replaces?:string; replacementId?:string;
};
export const inboxRows = sqliteTable("agent_inbox", {
	sequence: integer().primaryKey({autoIncrement:true}),
	id: text().notNull().unique(),
	kind: text({enum:["proposal","question","notification"]}).notNull(),
	status: text().$type<import("../interfaces/agent-inbox.ts").InboxItem["status"]>().notNull(),
	document: text({mode:"json"}).$type<InboxDocument>().notNull(),
	createdAt: text().notNull(), version: integer().notNull().default(1),
	read: integer({mode:"boolean"}).notNull().default(false),
	archived: integer({mode:"boolean"}).notNull().default(false),
	due: integer(), attempts: integer().notNull().default(0),
}, t=>[index("agent_inbox_pending").on(t.status,t.sequence),index("agent_inbox_due").on(t.due)]);
