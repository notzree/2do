import { env } from "cloudflare:workers";
import { instrument, setProvider } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";
import type { UserPlanner } from "./user-planner.ts";
import { sideConversation } from "./agents/chat-identity.ts";
import { createAgentRouter } from "@flue/runtime/routing";
import { plannerApi } from "./routes/planner-api.ts";
import { identify } from "./access.ts";
import { Copilot } from "./agents/copilot.ts";
import { chatId } from "./routes/chats.ts";
import { plannerOperations, publicOperations, openApiDocument } from "./routes/contract.ts";

// Flue recognizes an existing installation by the tracing object's identity.
const tracing = import.meta.hot?.data.tracing ?? createCloudflareTracing({ content: false });
if (import.meta.hot) import.meta.hot.data.tracing = tracing;
instrument(tracing);
if (env.AI)
	setProvider(
		cloudflareBindingProvider({
			binding: env.AI,
			gateway: { id: "default", collectLog: false, skipCache: true },
		}),
	);

type PlannerBindings = Omit<Env, "USER_PLANNER"> & {
	USER_PLANNER: DurableObjectNamespace<UserPlanner>;
};
const app = plannerApi<{ Bindings: PlannerBindings }>();
app.use(async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
});
app.openapi(publicOperations.health, (c) => c.json({ status: "ok" } as const, 200));
app.all(publicOperations.health.path, (c) => {
	c.header("Allow", "GET");
	return c.json({ error: "Method not allowed" }, 405);
});
app.openapi(publicOperations.openapi, (c) => c.json(openApiDocument(), 200));

async function dispatch(request: Request, env: PlannerBindings) {
	const identity = await identify(request, env);
	if (identity instanceof Response) return identity;
	return env.USER_PLANNER.getByName(identity).fetch(request);
}
for (const operation of Object.values(plannerOperations)) {
	app.on(operation.method, operation.getRoutingPath(), (c) => dispatch(c.req.raw, c.env));
}

const copilot = createAgentRouter(Copilot);
const mount = "/api/agents/copilot";
app.all(mount + "/*", async (c) => {
	const identity = await identify(c.req.raw, c.env);
	if (typeof identity !== "string") return identity;
	const url = new URL(c.req.url);
	const [chat, ...rest] = url.pathname.slice(mount.length + 1).split("/");
	let conversation = identity;
	if (chat !== "me" && chat !== encodeURIComponent(identity)) {
		if (
			!chatId.safeParse(chat).success ||
			!(await c.env.USER_PLANNER.getByName(identity).hasSideChat(chat))
		)
			return c.json({ error: "Not found" }, 404);
		conversation = sideConversation(identity, chat);
	}
	const publicUrl = url.href;
	url.pathname = ["/" + encodeURIComponent(conversation), ...rest].join("/");
	const response = await copilot.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
	// Flue generates the admission URL from its internal mount-relative request.
	if (response.status === 202 && response.headers.has("Location")) {
		const receipt = await response.json<{ streamUrl: string }>();
		const headers = new Headers(response.headers);
		headers.set("Location", publicUrl);
		return Response.json({ ...receipt, streamUrl: publicUrl }, { status: 202, headers });
	}
	return response;
});

export default app;
