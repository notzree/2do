import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import { identify } from "./access.ts";
import { Copilot } from "./agents/copilot.ts";
import { operations as op, openApiDocument } from "./routes/contract.ts";

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

// The Copilot agent keeps one durable conversation per verified identity.
// Clients address it as "me"; this wrapper authenticates first and rewrites
// that alias to the caller's identity, so nobody can reach — or even name —
// another account's conversation. Authentication must happen here, before
// admission: after Flue forwards accepted work into its Durable Object, the
// original request context is not reconstructed.
const copilot = createAgentRouter(Copilot);
const mount = "/api/agents/copilot";
app.all(mount + "/*", async (c) => {
	const identity = await identify(c.req.raw, c.env);
	if (typeof identity !== "string") return identity;
	const scoped = encodeURIComponent(identity);
	const { pathname } = new URL(c.req.url);
	const segments = pathname.split("/");
	const conversation = segments[4] ?? "";
	if (conversation !== "me" && conversation !== scoped)
		return c.json({ error: "Not found" }, 404);
	// The router is a Hono sub-app with mount-relative routes, so hand it the
	// identity-qualified path under its own root, not the public one.
	const url = new URL(c.req.url);
	url.pathname = ["/" + scoped, ...segments.slice(5)].join("/");
	return copilot.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
export default app;
