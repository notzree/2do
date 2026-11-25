import type { Env as HonoEnv } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { PlannerError } from "../core/planner.ts";

export function plannerApi<E extends HonoEnv = HonoEnv>() {
	const app = new OpenAPIHono<E>({
		defaultHook(result) {
			if (!result.success) throw result.error;
		},
	});
	app.onError((error, c) => {
		if (error instanceof z.ZodError) return c.json({ error: z.prettifyError(error) }, 400);
		if (error instanceof PlannerError || error instanceof HTTPException)
			return c.json({ error: error.message }, error.status);
		console.error("Planner request failed", error.name);
		return c.json({ error: "Internal error" }, 500);
	});
	app.notFound((c) => c.json({ error: "Not found" }, 404));
	return app;
}
