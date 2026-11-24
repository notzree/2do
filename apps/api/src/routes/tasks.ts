import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { Planner, PlannerError } from "../core/planner.ts";
import { operations as op, schemas } from "./contract.ts";

async function body<S extends z.ZodType>(ctx: Context, schema: S): Promise<z.output<S>> {
	if (ctx.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
		throw new HTTPException(415, { message: "Expected application/json" });
	}
	let value: unknown;
	try {
		value = await ctx.req.json();
	} catch {
		throw new HTTPException(400, { message: "Invalid JSON" });
	}
	return schema.parse(value);
}

export function plannerRoutes(planner: Planner) {
	const app = new Hono();
	app.use(bodyLimit({ maxSize: 16384, onError: (c) => c.json({ error: "Body too large" }, 413) }));
	app.onError((error, c) => {
		if (error instanceof z.ZodError) return c.json({ error: z.prettifyError(error) }, 400);
		if (error instanceof PlannerError || error instanceof HTTPException)
			return c.json({ error: error.message }, error.status);
		console.error("Planner request failed", error.name);
		return c.json({ error: "Internal error" }, 500);
	});
	app.on(op.listTasks.method, op.listTasks.path, (c) => c.json(planner.plan()));
	app.on(op.createTask.method, op.createTask.path, async (c) =>
		c.json(planner.create(await body(c, schemas[op.createTask.body])), op.createTask.status),
	);
	app.on(op.getTask.method, op.getTask.path, (c) =>
		c.json(planner.get(op.getTask.params.id.parse(c.req.param("id")))),
	);
	app.on(op.updateTask.method, op.updateTask.path, async (c) =>
		c.json(
			planner.update(
				op.updateTask.params.id.parse(c.req.param("id")),
				await body(c, schemas[op.updateTask.body]),
			),
		),
	);
	app.on(op.deleteTask.method, op.deleteTask.path, (c) => {
		planner.remove(op.deleteTask.params.id.parse(c.req.param("id")));
		return c.body(null, 204);
	});
	app.on(op.traverse.method, op.traverse.path, (c) => {
		const { id, direction } = z.object(op.traverse.params).parse(c.req.param());
		return c.json({ taskIds: planner.traverse(id, direction) });
	});
	for (const route of [op.addDependency, op.removeDependency]) {
		app.on(route.method, route.path, (c) => {
			planner.setDependency(z.object(route.params).parse(c.req.param()), route.method === "put");
			return c.body(null, 204);
		});
	}
	app.notFound((c) => c.json({ error: "Not found" }, 404));
	return app;
}
