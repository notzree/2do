import { Hono } from "hono";
import { identify } from "./access.ts";
import { operations as op, openApiDocument } from "./routes/contract.ts";

export { UserPlanner } from "./user-planner.ts";

const app = new Hono<{ Bindings: Env }>();
app.use(async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
});
app.on(op.health.method, op.health.path, (c) => c.json({ status: "ok" }));
app.all(op.health.path, (c) => {
	c.header("Allow", "GET");
	return c.json({ error: "Method not allowed" }, 405);
});
app.on(op.openapi.method, op.openapi.path, (c) => c.json(openApiDocument()));

async function dispatch(request: Request, env: Env) {
	const identity = await identify(request, env);
	if (identity instanceof Response) return identity;
	return env.USER_PLANNER.getByName(identity).fetch(request);
}
for (const prefix of ["/api/tasks", "/api/dependencies", "/api/days", "/api/images"]) {
	app.all(prefix, (c) => dispatch(c.req.raw, c.env));
	app.all(prefix + "/*", (c) => dispatch(c.req.raw, c.env));
}
app.notFound((c) => c.json({ error: "Not found" }, 404));
export default app;
