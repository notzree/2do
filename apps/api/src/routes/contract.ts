import { z } from "zod";
import { createTask, direction, patchTask, plan, task, taskId } from "../interfaces/plan.ts";

import {dayPage,writePage,imageId} from "../interfaces/notebook.ts";

export const schemas = {
	DayPage: dayPage,
	WritePage: writePage,
	ImageReceipt:z.strictObject({id:imageId}),
	CreateTask: createTask,
	PatchTask: patchTask,
	Task: task,
	Plan: plan,
	Traversal: z.strictObject({ taskIds: z.array(taskId) }),
	Error: z.object({ error: z.string() }),
	Health: z.object({ status: z.literal("ok") }),
	OpenAPI: z.looseObject({ openapi: z.string() }),
};
type Operation = {
	mcp?: boolean;
	method: "get" | "post" | "patch" | "put" | "delete";
	path: string;
	summary: string;
	status: number;
	response?: keyof typeof schemas;
	body?: "CreateTask" | "PatchTask" | "WritePage";
	params?: Record<string, z.ZodType>;
};
export const operations = {
	health: {
		method: "get",
		path: "/api/health",
		summary: "Check service health",
		status: 200,
		response: "Health",
	},
	openapi: {
		method: "get",
		path: "/api/openapi.json",
		summary: "Read the API contract",
		status: 200,
		response: "OpenAPI",
	},
	readPage: {mcp:true,method:"get",path:"/api/days/:date",summary:"Read a day document",status:200,params:{date:z.iso.date()},response:"DayPage"},
	writePage: {mcp:true,method:"put",path:"/api/days/:date",summary:"Save a day at its reviewed revision and create embedded tasks atomically",status:200,params:{date:z.iso.date()},body:"WritePage",response:"DayPage"},
	uploadImage:{method:"post",path:"/api/images",summary:"Upload a private PNG, JPEG, GIF or WebP, up to 8 MiB",status:201,response:"ImageReceipt"},
	readImage:{method:"get",path:"/api/images/:id",summary:"Read an image belonging to the current planner",status:200,params:{id:imageId}},
	listTasks: {
		mcp: true,
		method: "get",
		path: "/api/tasks",
		summary: "Read the plan in prerequisite-first order",
		status: 200,
		response: "Plan",
	},
	createTask: {
		mcp: true,
		method: "post",
		path: "/api/tasks",
		summary: "Create a task, optionally splicing it before or after an anchor",
		status: 201,
		body: "CreateTask",
		response: "Task",
	},
	getTask: {
		mcp: true,
		method: "get",
		path: "/api/tasks/:id",
		summary: "Read a task",
		status: 200,
		params: { id: taskId },
		response: "Task",
	},
	updateTask: {
		mcp: true,
		method: "patch",
		path: "/api/tasks/:id",
		summary: "Update task fields",
		status: 200,
		params: { id: taskId },
		body: "PatchTask",
		response: "Task",
	},
	deleteTask: {
		mcp: true,
		method: "delete",
		path: "/api/tasks/:id",
		summary: "Delete a task and its incident edges",
		status: 204,
		params: { id: taskId },
	},
	traverse: {
		mcp: true,
		method: "get",
		path: "/api/tasks/:id/traverse/:direction",
		summary: "List unique transitive ancestors or descendants, excluding the starting task",
		status: 200,
		params: { id: taskId, direction },
		response: "Traversal",
	},
	addDependency: {
		mcp: true,
		method: "put",
		path: "/api/dependencies/:from/:to",
		summary: "Require from to finish before to starts",
		status: 204,
		params: { from: taskId, to: taskId },
	},
	removeDependency: {
		mcp: true,
		method: "delete",
		path: "/api/dependencies/:from/:to",
		summary: "Remove a prerequisite edge",
		status: 204,
		params: { from: taskId, to: taskId },
	},
} as const satisfies Record<string, Operation>;

function json(name: keyof typeof schemas) {
	return { "application/json": { schema: { $ref: "#/components/schemas/" + name } } };
}
function schema(value: z.ZodType, io: "input" | "output" = "output") {
	const { $schema, ...result } = z.toJSONSchema(value, { io, target: "draft-2020-12" });
	return result;
}

const errorResponses = {
	400: "Invalid input",
	401: "Cloudflare Access authentication required",
	404: "Resource not found",
	409: "Graph or ID conflict",
	413: "Body too large",
	415: "JSON required",
	503: "Authentication unavailable",
};
export function openApiDocument() {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const [operationId, op] of Object.entries<Operation>(operations)) {
		const path = op.path.replace(/:(\w+)/g, "{$1}");
		const responses: Record<number, unknown> = {
			[op.status]: op.response
				? { description: "Success", content: json(op.response) }
				: { description: "Success" },
		};
		const media = Object.fromEntries(["image/png","image/jpeg","image/gif","image/webp"].map(type=>[type,{schema:{type:"string",format:"binary"}}]));
		if(operationId==="readImage") responses[200]={description:"Private image",content:media};
		const protectedRoute = operationId !== "health" && operationId !== "openapi";
		const failures = protectedRoute ? [401, 503] : [];
		if (op.params || op.body) failures.push(400, 404);
		if (op.body || operationId === "uploadImage") failures.push(413, 415);
		if (["createTask", "updateTask", "addDependency", "writePage"].includes(operationId)) failures.push(409);
		for (const status of failures)
			responses[status] = { $ref: "#/components/responses/Error" + status };
		(paths[path] ??= {})[op.method] = {
			operationId,
			...(op.mcp && { "x-mcp": true }),
			summary: op.summary,
			responses,
			...(operationId === "uploadImage" && {requestBody:{required:true,content:media}}),
			...(op.body && { requestBody: { required: true, content: json(op.body) } }),
			...(op.params && {
				parameters: Object.entries(op.params).map(([name, value]) => ({
					name,
					in: "path",
					required: true,
					schema: schema(value),
				})),
			}),
		};
	}
	return {
		openapi: "3.1.0",
		info: { title: "2do Planner", version: "1.0.0" },
		paths,
		security: [{ AccessSession: [] }],
		components: {
			responses: Object.fromEntries(
				Object.entries(errorResponses).map(([code, description]) => [
					"Error" + code,
					{ description, content: json("Error") },
				]),
			),
			securitySchemes: {
				AccessSession: { type: "apiKey", in: "cookie", name: "CF_Authorization" },
			},
			schemas: Object.fromEntries(
				Object.entries(schemas).map(([name, value]) => [
					name,
					schema(value, name === "CreateTask" || name === "PatchTask" || name === "WritePage" ? "input" : "output"),
				]),
			),
		},
	};
}
