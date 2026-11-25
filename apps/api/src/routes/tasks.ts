import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	accessErrors,
	conflict,
	invalidInput,
	jsonBody,
	jsonErrors,
	jsonResponse,
	named,
	missing,
} from "./responses.ts";
import { jsonLimits } from "./json-body.ts";
import { actionId, workflowCommand, workflowReceipt } from "../interfaces/plugin-workflows.ts";
import type { Planner } from "../core/planner.ts";
import { HTTPException } from "hono/http-exception";
import type { TaskClassification } from "../core/task-classification.ts";
import type { PlannerCaller } from "./review.ts";
import { sameTime } from "../interfaces/review.ts";
import { deleteTaskReceipt } from "../interfaces/notebook.ts";
import type { TaskPlugins } from "../core/task-plugins.ts";
import type { CommitTaskWrite } from "../interfaces/database.ts";
import {
	createTask,
	direction,
	edge,
	patchTask,
	plan,
	task,
	taskId,
	taskSearch,
	taskSearchResult,
} from "../interfaces/plan.ts";
import {
	pluginId,
	pluginInstallation,
	pluginInstallations,
	subtypeId,
	taskDetails,
	taskSubtype,
	writePluginInstallation,
	writeTaskSubtype,
} from "../interfaces/task-plugins.ts";

const taskParams = z.object({ id: taskId });
const dependencyQuery = z.object({
	expectedRevision: z.string().regex(/^(0|[1-9][0-9]*)$/)
		.refine((value) => Number.isSafeInteger(Number(value)), "Invalid plan revision")
		.optional()
		.describe(
			"Plan revision reviewed by the caller. An already-applied change succeeds at any revision.",
		),
});

export const taskOperations = {
	runPluginAction: createRoute({
		operationId: "runPluginAction",
		method: "post",
		path: "/api/tasks/{id}/subtypes/{typeId}/actions/{actionId}",
		summary:
			"Run an available plugin command at its reviewed revisions. Repeat the command ID for safe replay.",
		"x-mcp": true,
		middleware: jsonLimits(),
		request: {
			params: z.object({ id: taskId, typeId: subtypeId, actionId }),
			body: jsonBody(named(workflowCommand, "PluginCommand")),
		},
		responses: {
			200: jsonResponse(named(workflowReceipt, "PluginCommandReceipt")),
			...accessErrors,
			...jsonErrors,
			404: missing,
			409: conflict,
		},
	}),
	classifyTask: createRoute({
		operationId: "classifyTask",
		method: "post",
		path: "/api/tasks/{id}/classify",
		summary: "Queue classification for an existing task or retry a failed check",
		request: { params: taskParams },
		responses: {
			202: jsonResponse(z.strictObject({ classification: z.literal("pending") })),
			...accessErrors,
			503: jsonResponse(z.object({ error: z.string() }), "Service unavailable"),
			400: invalidInput,
			404: missing,
			409: conflict,
		},
	}),
	searchTasks: createRoute({
		operationId: "searchTasks",
		method: "post",
		path: "/api/tasks/search",
		summary:
			"Find matching tasks by title, completion, calendar day or timed interval. Page through results using nextCursor.",
		"x-mcp": true,
		"x-mcp-annotations": {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		middleware: jsonLimits(),
		request: { body: jsonBody(named(taskSearch, "TaskSearch")) },
		responses: {
			200: jsonResponse(named(taskSearchResult, "TaskSearchResult")),
			...accessErrors,
			...jsonErrors,
		},
	}),
	listTasks: createRoute({
		operationId: "listTasks",
		method: "get",
		path: "/api/tasks",
		summary: "Read the plan in prerequisite-first order",
		"x-mcp": true,
		responses: { 200: jsonResponse(named(plan, "Plan")), ...accessErrors },
	}),
	createTask: createRoute({
		operationId: "createTask",
		method: "post",
		path: "/api/tasks",
		summary: "Create a task, optionally splicing it before or after an anchor",
		"x-mcp": true,
		middleware: jsonLimits(),
		request: { body: jsonBody(named(createTask, "CreateTask")) },
		responses: {
			201: jsonResponse(named(task, "Task")),
			...accessErrors,
			...jsonErrors,
			404: missing,
			409: conflict,
		},
	}),
	getTask: createRoute({
		operationId: "getTask",
		method: "get",
		path: "/api/tasks/{id}",
		summary: "Read a task",
		"x-mcp": true,
		request: { params: taskParams },
		responses: {
			200: jsonResponse(named(task, "Task")),
			...accessErrors,
			400: invalidInput,
			404: missing,
		},
	}),
	updateTask: createRoute({
		operationId: "updateTask",
		method: "patch",
		path: "/api/tasks/{id}",
		summary:
			"Update only the requested fields at the task’s reviewed revision. Read the latest task on conflict.",
		"x-mcp": true,
		middleware: jsonLimits(),
		request: { params: taskParams, body: jsonBody(named(patchTask, "PatchTask")) },
		responses: {
			200: jsonResponse(named(task, "Task")),
			...accessErrors,
			...jsonErrors,
			404: missing,
			409: conflict,
		},
	}),
	readTaskDetails: createRoute({
		operationId: "readTaskDetails",
		method: "get",
		path: "/api/tasks/{id}/details",
		summary: "Read a task and its plugin subtypes",
		"x-mcp": true,
		request: { params: taskParams },
		responses: {
			200: jsonResponse(named(taskDetails, "TaskDetails")),
			...accessErrors,
			400: invalidInput,
			404: missing,
		},
	}),
	writeTaskSubtype: createRoute({
		operationId: "writeTaskSubtype",
		method: "put",
		path: "/api/tasks/{id}/subtypes/{typeId}",
		summary: "Attach or replace subtype data at its current revision, or reject it with null data",
		"x-mcp": true,
		middleware: jsonLimits(),
		request: {
			params: z.object({ id: taskId, typeId: subtypeId }),
			body: jsonBody(named(writeTaskSubtype, "WriteTaskSubtype")),
		},
		responses: {
			200: jsonResponse(named(taskSubtype, "TaskSubtype")),
			...accessErrors,
			...jsonErrors,
			404: missing,
			409: conflict,
		},
	}),
	listTaskPlugins: createRoute({
		operationId: "listTaskPlugins",
		method: "get",
		path: "/api/task-plugins",
		summary: "List task plugins and their installation state",
		"x-mcp": true,
		responses: {
			200: jsonResponse(named(pluginInstallations, "PluginInstallations")),
			...accessErrors,
		},
	}),
	setTaskPluginEnabled: createRoute({
		operationId: "setTaskPluginEnabled",
		method: "put",
		path: "/api/task-plugins/{pluginId}",
		summary: "Enable or disable a task plugin for the signed-in user",
		middleware: jsonLimits(),
		request: {
			params: z.object({ pluginId }),
			body: jsonBody(named(writePluginInstallation, "WritePluginInstallation")),
		},
		responses: {
			200: jsonResponse(named(pluginInstallation, "PluginInstallation")),
			...accessErrors,
			...jsonErrors,
			404: missing,
		},
	}),
	deleteTask: createRoute({
		operationId: "deleteTask",
		method: "delete",
		path: "/api/tasks/{id}",
		summary: "Delete the task, its incident edges and its references on every notebook page",
		"x-mcp": true,
		request: { params: taskParams, query: z.object({
			withPages: z.enum(["true", "false"]).optional(),
			expectedRevision: z.string().regex(/^(0|[1-9][0-9]*)$/)
				.refine((value) => Number.isSafeInteger(Number(value)), "Invalid task revision")
				.optional().describe("Delete only the task revision the caller reviewed."),
		}) },
		responses: {
			200: jsonResponse(named(deleteTaskReceipt, "DeleteTaskReceipt"), "Affected page revisions when withPages=true"),
			204: { description: "Deleted" },
			...accessErrors,
			400: invalidInput,
			404: missing,
			409: conflict,
		},
	}),
	traverse: createRoute({
		operationId: "traverse",
		method: "get",
		path: "/api/tasks/{id}/traverse/{direction}",
		summary: "List unique transitive ancestors or descendants, excluding the starting task",
		"x-mcp": true,
		request: { params: z.object({ id: taskId, direction }) },
		responses: {
			200: jsonResponse(z.strictObject({ taskIds: z.array(taskId) }).openapi("Traversal")),
			...accessErrors,
			400: invalidInput,
			404: missing,
		},
	}),
	addDependency: createRoute({
		operationId: "addDependency",
		method: "put",
		path: "/api/dependencies/{from}/{to}",
		summary: "Require from to finish before to starts",
		"x-mcp": true,
		request: { params: edge, query: dependencyQuery },
		responses: {
			204: { description: "Success" },
			...accessErrors,
			400: invalidInput,
			404: missing,
			409: conflict,
		},
	}),
	removeDependency: createRoute({
		operationId: "removeDependency",
		method: "delete",
		path: "/api/dependencies/{from}/{to}",
		summary: "Remove a prerequisite edge",
		"x-mcp": true,
		request: { params: edge, query: dependencyQuery },
		responses: {
			204: { description: "Success" },
			...accessErrors,
			400: invalidInput,
			404: missing,
			409: conflict,
		},
	}),
};

export function plannerRoutes(
	planner: Planner,
	plugins: TaskPlugins,
	commit: CommitTaskWrite,
	classification: TaskClassification | undefined,
) {
	const app = new OpenAPIHono<PlannerCaller>();
	const op = taskOperations;
	app.openapi(op.runPluginAction, async (c) => {
		const { id, typeId, actionId } = c.req.valid("param");
		return c.json(
			await plugins.workflows.command(id, typeId, actionId, c.req.valid("json"), commit),
			200,
		);
	});
	app.openapi(op.classifyTask, async (c) => {
		if (!classification)
			return c.json({ error: "Workers AI is unavailable in this planner." }, 503);
		await commit(() => classification.request(c.req.valid("param").id));
		return c.json({ classification: "pending" } as const, 202);
	});
	app.openapi(op.searchTasks, (c) => c.json(planner.search(c.req.valid("json")), 200));
	app.openapi(op.listTasks, (c) => c.json(planner.plan(), 200));
	app.openapi(op.createTask, async (c) =>
		c.json(await commit(() => planner.create(c.req.valid("json"))), 201),
	);
	app.openapi(op.getTask, (c) => c.json(planner.get(c.req.valid("param").id), 200));
	app.openapi(op.updateTask, async (c) => {
		const { id } = c.req.valid("param");
		const patch = c.req.valid("json");
		return c.json(
			await commit(() => {
				if (c.env?.fromAgent && patch.schedule !== undefined) {
					const current = planner.get(id).schedule;
					if (current?.type === "fixed" && !sameTime(patch.schedule, current))
						throw new HTTPException(409, {
							message: "Use proposeTime for a fixed event. Its schedule requires user review.",
						});
				}
				return planner.update(id, patch);
			}),
			200,
		);
	});
	app.openapi(op.readTaskDetails, (c) => c.json(plugins.details(c.req.valid("param").id), 200));
	app.openapi(op.writeTaskSubtype, async (c) => {
		const { id, typeId } = c.req.valid("param");
		return c.json(await commit(() => plugins.write(id, typeId, c.req.valid("json"))), 200);
	});
	app.openapi(op.listTaskPlugins, (c) => c.json(plugins.installations(), 200));
	app.openapi(op.setTaskPluginEnabled, async (c) => {
		const { pluginId } = c.req.valid("param");
		const { enabled } = c.req.valid("json");
		return c.json(await commit(() => plugins.setEnabled(pluginId, enabled)), 200);
	});
	app.openapi(op.deleteTask, async (c) => {
		const { expectedRevision, withPages } = c.req.valid("query");
		const receipt = await commit(() =>
			planner.remove(
				c.req.valid("param").id,
				expectedRevision === undefined ? undefined : Number(expectedRevision),
			),
		);
		if (withPages === "true") return c.json(receipt, 200);
		return c.body(null, 204);
	});
	app.openapi(op.traverse, (c) => {
		const { id, direction } = c.req.valid("param");
		return c.json({ taskIds: planner.traverse(id, direction) }, 200);
	});
	app.openapi(op.addDependency, (c) => {
		const { expectedRevision } = c.req.valid("query");
		planner.setDependency(c.req.valid("param"), true, expectedRevision === undefined ? undefined : Number(expectedRevision));
		return c.body(null, 204);
	});
	app.openapi(op.removeDependency, (c) => {
		const { expectedRevision } = c.req.valid("query");
		planner.setDependency(c.req.valid("param"), false, expectedRevision === undefined ? undefined : Number(expectedRevision));
		return c.body(null, 204);
	});
	return app;
}
