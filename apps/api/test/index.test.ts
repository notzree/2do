import { env, SELF } from "cloudflare:test";
import document from "../openapi.json";
import { expect, it } from "vite-plus/test";
import { checkAccess, checkPlanner } from "./scenarios.ts";

it("serves the API health check", async () => {
	const response = await SELF.fetch("https://example.com/api/health");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ status: "ok" });
});

it("documents the empty-page read and revision-conflict write for a new day", async () => {
	const response = await SELF.fetch("https://example.com/api/openapi.json");
	expect(response.status).toBe(200);
	const spec = await response.json<typeof document>();
	expect(spec).toEqual(document);
	const day = spec.paths["/api/days/{date}"];
	expect(day.get.operationId).toBe("readPage");
	expect(day.get["x-mcp"]).toBe(true);
	expect(day.get.responses).toHaveProperty("200");
	expect(day.get.responses).not.toHaveProperty("404");
	expect(day.put.responses).toHaveProperty("409");
	const fresh = await env.USER_PLANNER.getByName(crypto.randomUUID()).fetch(
		"https://test/api/days/2026-11-24",
	);
	expect(fresh.status).toBe(200);
	expect(await fresh.json()).toMatchObject({
		revision: 0,
		doc: { content: [{ type: "paragraph" }] },
	});
});

it("returns a JSON 404 for unknown routes", async () => {
	const response = await SELF.fetch("https://example.com/api/missing");
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: "Not found" });
});

it("rejects writes to the health endpoint", async () => {
	const response = await SELF.fetch("https://example.com/api/health", { method: "POST" });
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("GET");
});

it("enforces the per-user graph and atomic edit semantics", () => checkPlanner(env));
it("accepts only verified Access identities", checkAccess);
it("rejects an anonymous task read", async () => {
	const response = await SELF.fetch("https://example.com/api/tasks");
	expect([401, 503]).toContain(response.status);
});

it("saves document and task together, rejects stale revisions, and replays the last save", async () => {
	const planner = env.USER_PLANNER.getByName(crypto.randomUUID());
	const url = "https://test/api/days/2026-11-23";
	const id = crypto.randomUUID();
	const doc = {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [{ type: "text", text: "Field notes", marks: [{ type: "em" }] }],
			},
			{ type: "taskRef", attrs: { id } },
		],
	};
	const write = (revision: number, content: unknown, newTasks: unknown[] = []) =>
		planner.fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ version: 1, revision, doc: content, newTasks }),
		});
	expect(await (await planner.fetch(url)).json()).toMatchObject({ version: 1, revision: 0 });
	expect((await write(0, doc, [{ id, title: "Check the results" }])).status).toBe(200);
	expect((await write(0, doc, [{ id, title: "Check the results" }])).status).toBe(200);
	expect((await write(0, doc, [{ id, title: "Different command" }])).status).toBe(409);
	expect((await write(0, doc, [])).status).toBe(409);
	expect((await write(0, { type: "doc", content: [{ type: "paragraph" }] })).status).toBe(409);
	const badId = crypto.randomUUID();
	expect(
		(
			await write(
				1,
				{
					type: "doc",
					content: [
						{ type: "taskRef", attrs: { id: badId } },
						{ type: "graphRef", attrs: { id: crypto.randomUUID() } },
					],
				},
				[{ id: badId, title: "Rollback" }],
			)
		).status,
	).toBe(404);
	expect((await planner.fetch("https://test/api/tasks/" + badId)).status).toBe(404);
	expect(await (await planner.fetch(url)).json()).toMatchObject({ revision: 1, doc });
	const other = env.USER_PLANNER.getByName(crypto.randomUUID());
	expect(await (await other.fetch(url)).json()).toMatchObject({ revision: 0 });
});

it("stores pasted images privately in R2 and checks image references per planner", async () => {
	const alice = env.USER_PLANNER.getByName(crypto.randomUUID()),
		bob = env.USER_PLANNER.getByName(crypto.randomUUID());
	const bytes = Uint8Array.from(
		atob(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6XkAAAAASUVORK5CYII=",
		),
		(c) => c.charCodeAt(0),
	);
	const url = "https://test/api/images";
	const uploaded = await alice.fetch(url, {
		method: "POST",
		headers: { "Content-Type": "image/png" },
		body: bytes,
	});
	expect(uploaded.status).toBe(201);
	const { id } = await uploaded.json<{ id: string }>();
	const image = await alice.fetch(url + "/" + id);
	expect(image.headers.get("Content-Type")).toBe("image/png");
	expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
	expect((await bob.fetch(url + "/" + id)).status).toBe(404);
	for (const [actor, status] of [
		[alice, 200],
		[bob, 404],
	] as const) {
		const result = await actor.fetch("https://test/api/days/2026-11-24", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				version: 1,
				revision: 0,
				newTasks: [],
				doc: { type: "doc", content: [{ type: "image", attrs: { id, alt: "Photo" } }] },
			}),
		});
		expect(result.status).toBe(status);
	}
	expect(
		(
			await alice.fetch(url, {
				method: "POST",
				headers: { "Content-Type": "image/png" },
				body: "plain text",
			})
		).status,
	).toBe(415);
});

it("accepts only reviewed task patches and pages filtered search results", async () => {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	const call = (path: string, method: string, value: object) =>
		stub.fetch("https://planner.test/api/" + path, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(value),
		});
	const create = async (value: object) =>
		(await call("tasks", "POST", value)).json<{ id: string; revision: number }>();
	const first = await create({
		title: "Draft chapter",
		schedule: { type: "day", date: "2026-11-24" },
	});
	const timed = await create({
		title: "Draft review",
		schedule: { type: "fixed", start: "2026-11-25T03:00:00Z", end: "2026-11-25T04:00:00Z" },
	});
	await create({ title: "Draft complete", completed: true });
	await create({
		title: "Draft at boundary",
		schedule: { type: "fixed", start: "2026-11-25T05:00:00Z", end: "2026-11-25T06:00:00Z" },
	});
	const patch = (fields: object) => call("tasks/" + first.id, "PATCH", fields);
	expect((await patch({ title: "unreviewed" })).status).toBe(400);
	expect((await patch({ revision: first.revision, durationMinutes: 50 })).status).toBe(200);
	expect((await patch({ revision: first.revision, title: "stale" })).status).toBe(409);
	const query = {
		title: "draft",
		completed: false,
		date: "2026-11-24",
		interval: { start: "2026-11-24T00:00:00-05:00", end: "2026-11-25T00:00:00-05:00" },
		limit: 1,
	};
	type Page = { tasks: { id: string; title: string }[]; nextCursor: string | null };
	const page = await (await call("tasks/search", "POST", query)).json<Page>();
	const next = await (
		await call("tasks/search", "POST", { ...query, after: page.nextCursor })
	).json<Page>();
	expect([...page.tasks, ...next.tasks].map((t) => t.id).sort()).toEqual(
		[first.id, timed.id].sort(),
	);
	expect(next.nextCursor).toBeNull();
	expect((await call("tasks/search", "POST", { limit: 51 })).status).toBe(400);
	const miss = await stub.fetch("https://planner.test/api/days/2026-11-24/extra");
	expect(miss.status).toBe(404);
	expect(await miss.json()).toEqual({ error: "Not found" });
});

it("enforces route-specific body limits and returns JSON errors", async () => {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	const send = (path: string, method: string, body: string, contentType = "application/json") =>
		stub.fetch("https://planner.test/api/" + path, {
			method,
			headers: { "Content-Type": contentType },
			body,
		});
	const text = "a".repeat(18 * 1024);
	const small = await send("tasks", "POST", JSON.stringify({ title: text }));
	expect(small.status).toBe(413);
	expect(await small.json()).toHaveProperty("error");
	const document = {
		version: 1,
		revision: 0,
		newTasks: [],
		doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
	};
	expect((await send("days/2026-11-24", "PUT", JSON.stringify(document))).status).toBe(200);
	expect((await send("days/2026-11-24", "PUT", "{")).status).toBe(400);
	expect((await send("tasks/search", "POST", "{}", "text/plain")).status).toBe(415);
});
