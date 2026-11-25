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
import type { Notebook } from "../core/notebook.ts";
import { dayPage, taskCapture, writePage } from "../interfaces/notebook.ts";
import { taskId } from "../interfaces/plan.ts";

const dayParams = z.object({ date: z.iso.date() });

export const notebookOperations = {
	readTaskCapture: createRoute({
		operationId: "readTaskCapture",
		method: "get",
		path: "/api/tasks/{id}/capture",
		summary: "Read the original notebook input and capture context, or null if unavailable",
		request: { params: z.object({ id: taskId }) },
		responses: {
			200: jsonResponse(named(taskCapture.nullable(), "TaskCapture")),
			...accessErrors,
			400: invalidInput,
			404: missing,
		},
	}),
	readPage: createRoute({
		operationId: "readPage",
		method: "get",
		path: "/api/days/{date}",
		summary: "Read a day document",
		"x-mcp": true,
		request: { params: dayParams },
		responses: { 200: jsonResponse(named(dayPage, "DayPage")), ...accessErrors, 400: invalidInput },
	}),
	writePage: createRoute({
		operationId: "writePage",
		method: "put",
		path: "/api/days/{date}",
		summary: "Save a day at its reviewed revision and create embedded tasks atomically",
		"x-mcp": true,
		middleware: jsonLimits(1024 * 1024, "Day document exceeds 1 MiB"),
		request: { params: dayParams, body: jsonBody(named(writePage, "WritePage")) },
		responses: {
			200: jsonResponse(named(dayPage, "DayPage")),
			...accessErrors,
			...jsonErrors,
			404: missing,
			409: conflict,
		},
	}),
};

export function notebookRoutes(notebook: Notebook) {
	const app = new OpenAPIHono();
	app.openapi(notebookOperations.readTaskCapture, (c) =>
		c.json(notebook.readTaskCapture(c.req.valid("param").id), 200),
	);
	app.openapi(notebookOperations.readPage, (c) =>
		c.json(notebook.readDay(c.req.valid("param").date), 200),
	);
	app.openapi(notebookOperations.writePage, async (c) =>
		c.json(await notebook.saveDay(c.req.valid("param").date, c.req.valid("json")), 200),
	);
	return app;
}
