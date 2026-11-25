import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { expect, it } from "vite-plus/test";
import migrations from "../drizzle/migrations.js";
import { plan, task } from "../src/interfaces/plan.ts";

it("initializes an empty planner and skips applied migrations on a populated planner", async () => {
	const planner = env.USER_PLANNER.getByName(crypto.randomUUID());
	const url = "https://planner.test/api/tasks";
	const readPlan = async () => plan.parse(await (await planner.fetch(url)).json());
	expect(await readPlan()).toEqual({ revision: 0, tasks: [], edges: [] });

	const response = await planner.fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title: "Review the plan" }),
	});
	expect(response.status).toBe(201);
	const created = task.parse(await response.json());

	await runInDurableObject(planner, async (_, ctx) => {
		await migrate(drizzle(ctx.storage), migrations);
		const rows = ctx.storage.sql.exec("SELECT count(*) AS count FROM __drizzle_migrations");
		expect(rows.one().count).toBe(migrations.journal.entries.length);
	});
	expect(await readPlan()).toEqual({ revision: 1, tasks: [created], edges: [] });
});
