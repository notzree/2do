import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vite-plus/test";
import migrations from "../drizzle/migrations.js";
import { migratePlanner } from "../src/db/migrate.ts";
import { dayPage } from "../src/interfaces/notebook.ts";
import { plan } from "../src/interfaces/plan.ts";

// Deployed raw SQL layout from 387e968. A fresh test planner is reset, seeded with
// these tables, and evicted so the production constructor handles the upgrade.
const legacySchema = `
	CREATE TABLE plan_head(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL);
	INSERT INTO plan_head VALUES (1, 19);
	CREATE TABLE task(id TEXT PRIMARY KEY NOT NULL, document TEXT NOT NULL);
	CREATE TABLE dependency(prerequisite TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
		dependent TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
		PRIMARY KEY(prerequisite, dependent), CHECK(prerequisite <> dependent));
	CREATE INDEX by_dependent ON dependency(dependent, prerequisite);
	CREATE TABLE day_page(day TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL);
	CREATE TABLE notebook_image(id TEXT PRIMARY KEY);
`;

it("opens the deployed raw SQLite layout, preserves its planner and notebook, and migrates it exactly once", async () => {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	const call = (path: string, method = "GET", body?: object) =>
		stub.fetch("https://planner.test/api/" + path, {
			method,
			...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		});
	const day = "2026-11-24";
	const meal = {
		id: crypto.randomUUID(),
		title: "Dinner",
		kind: "meal",
		completed: true,
		schedule: { type: "day", date: day },
		durationMinutes: 45,
	};
	const child = {
		id: crypto.randomUUID(),
		parentId: meal.id,
		title: "Wash up",
		kind: "task",
		completed: false,
		schedule: null,
		durationMinutes: null,
	};
	const imageId = "a".repeat(64);
	const doc = {
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "Keep this note" }] },
			{ type: "taskRef", attrs: { id: meal.id } },
			{ type: "graphRef", attrs: { id: child.id } },
			{ type: "image", attrs: { id: imageId, alt: "Original image" } },
		],
	};
	const bytes = Uint8Array.of(137, 80, 78, 71);
	await runInDurableObject(stub, async (_, ctx) => {
		await ctx.storage.deleteAll();
		const sql = ctx.storage.sql;
		sql.exec(legacySchema);
		for (const t of [meal, child])
			sql.exec("INSERT INTO task VALUES (?, ?)", t.id, JSON.stringify(t));
		sql.exec("INSERT INTO dependency VALUES (?, ?)", meal.id, child.id);
		sql.exec("INSERT INTO day_page VALUES (?, ?, ?)", day, 7, JSON.stringify(doc));
		sql.exec("INSERT INTO notebook_image VALUES (?)", imageId);
		await env.NOTEBOOK_IMAGES.put(ctx.id.toString() + "/" + imageId, bytes, {
			httpMetadata: { contentType: "image/png" },
		});
	});
	await evictDurableObject(stub);

	const expected = {
		revision: 19,
		tasks: [
			{ ...meal, kind: "task", parentId: null, revision: 19 },
			{ ...child, revision: 19 },
		],
		edges: [{ from: meal.id, to: child.id }],
	};
	const read = async () => plan.parse(await (await call("tasks")).json());
	expect(await read()).toEqual(expected);
	expect(dayPage.parse(await (await call("days/" + day)).json())).toEqual({
		version: 1,
		revision: 7,
		doc,
	});
	expect(new Uint8Array(await (await call("images/" + imageId)).arrayBuffer())).toEqual(bytes);
	expect(await (await call("task-plugins")).json()).toMatchObject([
		{ id: "nutrition", enabled: false },
		{ id: "fitness", enabled: false }, { id: "budgeting", enabled: false }, { id: "productivity", enabled: false },
	]);
	await runInDurableObject(stub, (_, ctx) => {
		const sql = ctx.storage.sql;
		expect(sql.exec("SELECT count(*) AS n FROM task_classification").one().n).toBe(0);
		expect(sql.exec("SELECT count(*) AS n FROM __drizzle_migrations").one().n).toBe(
			migrations.journal.entries.length,
		);
		expect(sql.exec("SELECT commandHash FROM day_page WHERE day = ?", day).one().commandHash).toBe(
			"",
		);
		expect(sql.exec("SELECT id FROM notebook_image").one().id).toBe(imageId);
	});
	await evictDurableObject(stub);
	expect(await read()).toEqual(expected);
	expect((await call("task-plugins/nutrition", "PUT", { enabled: true })).status).toBe(200);
	expect(await (await call("tasks/" + meal.id + "/details")).json()).toMatchObject({
		classification: "idle",
		subtypes: [{ typeId: "nutrition.meal", source: "manual", data: {}, revision: meal.id }],
	});
	expect((await call("tasks/" + child.id, "PATCH", { revision: 19, completed: true })).status).toBe(
		200,
	);
	expect((await read()).revision).toBe(20);
	expect(
		(await call("days/" + day, "PUT", { version: 1, revision: 7, doc, newTasks: [] })).status,
	).toBe(200);
});

it("rolls the whole bridge back when a legacy task cannot be imported", async () => {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	await runInDurableObject(stub, async (_, ctx) => {
		await ctx.storage.deleteAll();
		const sql = ctx.storage.sql;
		sql.exec(legacySchema);
		const id = crypto.randomUUID();
		sql.exec("INSERT INTO task VALUES (?, ?)", id, "malformed-json");
		await expect(migratePlanner(drizzle(ctx.storage))).rejects.toThrow();
		expect(sql.exec("SELECT document FROM task WHERE id = ?", id).one().document).toBe(
			"malformed-json",
		);
		expect(sql.exec("SELECT revision FROM plan_head").one().revision).toBe(19);
		expect(
			sql
				.exec(
					"SELECT name FROM sqlite_master WHERE name LIKE 'legacy_%' OR name = '__drizzle_migrations'",
				)
				.toArray(),
		).toEqual([]);
	});
});

it("upgrades saved metric targets to core goals once while retaining their reporting history",async()=>{
	const stub=env.USER_PLANNER.getByName(crypto.randomUUID());
	const id=crypto.randomUUID(), revision=crypto.randomUUID();
	const old={id,revision,label:"Daily protein",timeZone:"America/Toronto",metric:{id:"nutrition.protein",label:"Protein",version:1,unit:"g",reducer:"sum"},
		versions:[{effectiveFrom:"2026-11-01",target:{comparator:"atLeast",value:50}},{effectiveFrom:"2026-11-12",target:{comparator:"atLeast",value:60}}]};
	await runInDurableObject(stub,async(_,ctx)=>{
		const sql=ctx.storage.sql;
		// Recreate the pre-goal storage boundary on this new, isolated test planner.
		sql.exec("DROP TABLE goal_task_link; DROP TABLE goal_check_in; DROP TABLE planner_goal");
		const step=migrations.journal.entries.find(e=>e.tag.endsWith("planner_goals"))!;
		sql.exec("DELETE FROM __drizzle_migrations WHERE created_at >= ?",step.when);
		sql.exec("INSERT INTO plugin_goal(id,creation,document) VALUES(?,?,?)",id,"original request",JSON.stringify(old));
		await migratePlanner(drizzle(ctx.storage));
		await migratePlanner(drizzle(ctx.storage));
		expect(sql.exec("SELECT COUNT(*) AS count FROM planner_goal").one().count).toBe(1);
	});
	await (await stub.fetch("https://test/api/task-plugins/nutrition",{method:"PUT",headers:{"content-type":"application/json"},body:'{"enabled":true}'})).json();
	expect(await (await stub.fetch("https://test/api/planner-goals")).json()).toMatchObject([{id,title:old.label,dailyMetric:"nutrition.protein"}]);
	expect(await (await stub.fetch("https://test/api/goals/"+id+"/history?from=2026-11-01&to=2026-11-13")).json()).toMatchObject({goal:old});
});
