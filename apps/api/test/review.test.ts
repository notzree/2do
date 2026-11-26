import { env, runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vite-plus/test";
import { task } from "../src/interfaces/plan.ts";
import { taskDetails } from "../src/interfaces/task-plugins.ts";
import { plannerConnection } from "../src/mcp/connection.ts";

function owner() {
	const id = crypto.randomUUID();
	const stub = env.USER_PLANNER.getByName(id);
	const call = (path: string, method = "GET", body?: object) =>
		stub.fetch("https://planner.test/api/" + path, {
			method,
			...(body && {
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		});
	return { id, call, stub };
}
const fixed = (hour: number) => ({
	type: "fixed",
	start: `2026-11-27T${hour}:00:00Z`,
	end: `2026-11-27T${hour + 1}:00:00Z`,
});

it("lets Copilot propose a fixed-event move and commits only the user's stored decision", async () => {
	const alice = owner(),
		bob = owner();
	const t = task.parse(
		await (await alice.call("tasks", "POST", { title: "Library", schedule: fixed(16) })).json(),
	);
	const proposal = {
		id: crypto.randomUUID(),
		taskId: t.id,
		revision: t.revision,
		after: fixed(17),
		reason: "Later session",
	};
	const conn = plannerConnection(env.USER_PLANNER, alice.id);
	const client = new Client({ name: "review-test", version: "1" });
	await client.connect(new StreamableHTTPClientTransport(new URL(conn.url), { fetch: conn.fetch }));
	try {
		const direct = await client.callTool({
			name: "updateTask",
			arguments: { id: t.id, requestBody: { revision: t.revision, schedule: fixed(17) } },
		});
		expect(direct.isError).toBe(true);
		const made = await client.callTool({
			name: "proposeTime",
			arguments: { requestBody: proposal },
		});
		expect(made.isError).toBeFalsy();
		expect((await client.listTools()).tools.some((tool) => tool.name === "decideTime")).toBe(false);
	} finally {
		await client.close();
	}
	expect(await (await alice.call("review")).json()).toMatchObject([
		{ id: proposal.id, source: "copilot", before: fixed(16), after: fixed(17) },
	]);
	expect(await (await alice.call("tasks/" + t.id)).json()).toMatchObject({ schedule: fixed(16) });
	const path = "review/" + proposal.id + "/decision";
	expect((await bob.call(path, "POST", { decision: "accept" })).status).toBe(404);
	expect(
		(await alice.call("tasks/" + t.id, "PATCH", { revision: t.revision, title: "New title" }))
			.status,
	).toBe(200);
	expect((await alice.call(path, "POST", { decision: "accept" })).status).toBe(200);
	const updated = task.parse(await (await alice.call("tasks/" + t.id)).json());
	expect(updated).toMatchObject({ title: "New title", schedule: fixed(17) });
	expect((await alice.call(path, "POST", { decision: "accept" })).status).toBe(200);
	expect(await (await alice.call("tasks/" + t.id)).json()).toEqual(updated);
	expect((await alice.call(path, "POST", { decision: "reject" })).status).toBe(409);
	expect(await (await alice.call("review")).json()).toEqual([]);
});

it("deduplicates repeated suggestions and preserves concurrent schedule changes", async () => {
	const { call } = owner();
	const t = task.parse(
		await (await call("tasks", "POST", { title: "Gym", schedule: fixed(16) })).json(),
	);
	const p = {
		id: crypto.randomUUID(),
		taskId: t.id,
		revision: t.revision,
		after: fixed(17),
		reason: "After work",
	};
	for (const id of [p.id, p.id, crypto.randomUUID()]) {
		expect(await (await call("review", "POST", { ...p, id })).json()).toMatchObject({ id: p.id });
	}
	expect(
		(await call("tasks/" + t.id, "PATCH", { revision: t.revision, schedule: fixed(18) })).status,
	).toBe(200);
	const path = "review/" + p.id + "/decision";
	expect((await call(path, "POST", { decision: "accept" })).status).toBe(409);
	expect((await call(path, "POST", { decision: "reject" })).status).toBe(200);
	expect(await (await call("tasks/" + t.id)).json()).toMatchObject({ schedule: fixed(18) });
});

it("checks a pre-existing task, reports a real negative result and preserves manual choices", async () => {
	const { stub, call } = owner();
	const t = task.parse(
		await (await call("tasks", "POST", { title: "Return a library book" })).json(),
	);
	const path = "tasks/" + t.id;
	expect((await call(path + "/classify", "POST")).status).toBe(409);
	await call("task-plugins/nutrition", "PUT", { enabled: true });
	expect((await call(path + "/classify", "POST")).status).toBe(202);
	await call(path + "/classify", "POST");
	await runInDurableObject(stub, async (instance) => {
		await instance.alarm!();
	});
	const checked = taskDetails.parse(await (await call(path + "/details")).json());
	expect(checked).toMatchObject({
		classification: "idle",
		lastClassification: { evaluated: ["nutrition.meal"], matched: [] },
	});
	await call(path + "/subtypes/nutrition.meal", "PUT", { revision: null, data: null });
	expect((await call(path + "/classify", "POST")).status).toBe(202);
	await runInDurableObject(stub, async (instance) => { await instance.alarm!(); });
	expect(taskDetails.parse(await (await call(path + "/details")).json())).toMatchObject({
		subtypes: [{ typeId: "nutrition.meal", source: "manual", data: null }],
		lastClassification: { evaluated: ["nutrition.meal"], matched: [] },
	});
	await call("task-plugins/nutrition", "PUT", { enabled: false });
	expect(
		taskDetails.parse(await (await call(path + "/details")).json()).lastClassification,
	).toBeUndefined();
});
