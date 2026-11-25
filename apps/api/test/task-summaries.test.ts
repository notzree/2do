import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { task } from "../src/interfaces/plan.ts";
import { taskSubtype } from "../src/interfaces/task-plugins.ts";
import { summaryBatchSize, taskSummaries } from "../src/interfaces/task-summaries.ts";

const typeId = "nutrition.meal";
const promptId = "nutrition.meal.foods";

function user() {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	const call = (path: string, method: string, body: object) =>
		stub.fetch("https://planner.test/api/" + path, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const list = (ids: string[]) => call("tasks/summaries", "POST", { ids });
	const summaries = async (...ids: string[]) => {
		const response = await list(ids);
		expect(response.status).toBe(200);
		return taskSummaries.parse(await response.json());
	};
	const create = async (title: string, completed = false) =>
		task.parse(await (await call("tasks", "POST", { title, completed })).json());
	const skip = (id: string, skipped: boolean, prompt: string = promptId) =>
		call("tasks/" + id + "/prompts/" + prompt, "PUT", { skipped });
	const enable = (enabled: boolean) => call("task-plugins/nutrition", "PUT", { enabled });
	const subtype = async (
		id: string,
		revision: string | null,
		data: Record<string, unknown> | null,
	) =>
		taskSubtype.parse(
			await (await call("tasks/" + id + "/subtypes/" + typeId, "PUT", { revision, data })).json(),
		);
	return { stub, call, summaries, list, create, skip, enable, subtype };
}

it("reads bounded batches, omits unknown and other planners' IDs, and works without installed plugins", async () => {
	const alice = user(),
		bob = user();
	const a = await alice.create("Return the library book");
	const b = await bob.create("Bring bike lights");
	const ids = Array.from({ length: summaryBatchSize }, () => crypto.randomUUID() as string);
	ids[0] = a.id;
	ids[1] = b.id;
	ids[2] = a.id;
	expect(await alice.summaries(...ids)).toEqual([
		{ id: a.id, classification: "idle", types: [], prompts: [], inlays: [] },
	]);
	expect(await bob.summaries(a.id)).toEqual([]);
	expect((await alice.list([])).status).toBe(400);
	expect((await alice.list([...ids, b.id])).status).toBe(400);
	expect((await alice.call("tasks/summaries", "POST", { ids: [b.id], owner: b.id })).status).toBe(
		400,
	);
});

it("persists skip and restore per task, and drops the hint when filled, reopened, or rejected", async () => {
	const alice = user(),
		bob = user();
	const dinner = await alice.create("Dinner", true);
	const lunch = await alice.create("Lunch", true);
	expect((await alice.enable(true)).status).toBe(200);
	const meal = await alice.subtype(dinner.id, null, {});
	await alice.subtype(lunch.id, null, {});
	const hint = async () => (await alice.summaries(dinner.id))[0].prompts;
	expect(await hint()).toMatchObject([{ id: promptId, field: "foods", skipped: false }]);
	expect((await bob.skip(dinner.id, true)).status).toBe(404);
	expect((await alice.skip(dinner.id, true, "unknown")).status).toBe(404);
	expect((await alice.skip(dinner.id, true)).status).toBe(204);
	expect((await alice.skip(dinner.id, true)).status).toBe(204);
	const batch = await alice.summaries(dinner.id, lunch.id);
	expect(batch.find((row) => row.id === dinner.id)?.prompts).toMatchObject([{ skipped: true }]);
	expect(batch.find((row) => row.id === lunch.id)?.prompts).toMatchObject([{ skipped: false }]);
	expect((await alice.enable(false)).status).toBe(200);
	expect(await hint()).toEqual([]);
	expect((await alice.skip(dinner.id, false)).status).toBe(404);
	expect((await alice.enable(true)).status).toBe(200);
	expect(await hint()).toMatchObject([{ skipped: true }]);
	expect((await alice.skip(dinner.id, false)).status).toBe(204);
	expect((await alice.skip(dinner.id, false)).status).toBe(204);
	expect(await hint()).toMatchObject([{ skipped: false }]);
	const filled = await alice.subtype(dinner.id, meal.revision, { foods: ["Rice"] });
	expect((await alice.summaries(dinner.id))[0].inlays).toEqual([
		{ typeId, field: "foods", label: "Foods", value: "Rice" },
	]);
	expect(await hint()).toEqual([]);
	expect((await alice.skip(dinner.id, true)).status).toBe(404);
	const missing = await alice.subtype(dinner.id, filled.revision, {});
	const reopened = task.parse(
		await (
			await alice.call("tasks/" + dinner.id, "PATCH", {
				revision: dinner.revision,
				completed: false,
			})
		).json(),
	);
	expect(await hint()).toEqual([]);
	await alice.call("tasks/" + dinner.id, "PATCH", { revision: reopened.revision, completed: true });
	expect(await hint()).toMatchObject([{ skipped: false }]);
	await alice.subtype(dinner.id, missing.revision, null);
	expect((await alice.summaries(dinner.id))[0]).toMatchObject({ types: [], prompts: [] });
});

it("hides superseded automatic data while reclassification runs and distinguishes failed work from pending", async () => {
	const alice = user();
	await alice.enable(true);
	const dinner = await alice.create("Get dinner at Nuri Village", true);
	await runInDurableObject(alice.stub, async (instance, state) => {
		state.storage.sql.exec("UPDATE task_classification SET due = 0");
		expect.assert(instance.alarm);
		await instance.alarm();
	});
	expect((await alice.summaries(dinner.id))[0]).toMatchObject({
		classification: "idle",
		types: [{ typeId, source: "automatic" }],
		prompts: [{ id: promptId }],
	});
	expect(
		(
			await alice.call("tasks/" + dinner.id, "PATCH", {
				revision: dinner.revision,
				title: "Return the library book",
			})
		).status,
	).toBe(200);
	await runInDurableObject(alice.stub, (_, state) => {
		state.storage.sql.exec(
			"UPDATE task_classification SET due = ? WHERE taskId = ?",
			Date.now() + 60_000,
			dinner.id,
		);
	});
	expect((await alice.summaries(dinner.id))[0]).toMatchObject({
		classification: "pending",
		types: [],
		prompts: [],
	});
	await runInDurableObject(alice.stub, (_, state) => {
		state.storage.sql.exec("UPDATE task_classification SET due = NULL WHERE taskId = ?", dinner.id);
	});
	expect((await alice.summaries(dinner.id))[0]).toMatchObject({
		classification: "failed",
		types: [],
		prompts: [],
	});
});
