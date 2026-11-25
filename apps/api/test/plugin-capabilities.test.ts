import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vite-plus/test";
import { z } from "zod";
import { Planner } from "../src/core/planner.ts";
import { TaskPlugins } from "../src/core/task-plugins.ts";
import { SqlitePlannerDatabase } from "../src/db/planner.ts";
import { SqliteTaskPluginDatabase } from "../src/db/task-plugins.ts";
import { createTask } from "../src/interfaces/plan.ts";
import {
	eligibleTaskPrompts,
	type PluginFactAccess,
	type TaskPlugin,
} from "../src/interfaces/task-plugins.ts";
import { mealType, nutritionPlugin } from "../src/plugins/meal.ts";

const study: TaskPlugin = {
	id: "study",
	label: "Study",
	subtypes: [
		{
			id: "study.session",
			label: "Study session",
			schemaVersion: 1,
			schema: z.strictObject({ target: z.object({ topics: z.array(z.string()) }).optional() }),
			initialData: {},
			editor: [
				{
					key: "target",
					fields: [
						{ key: "topics", label: "Topics", kind: "text-list", maxItems: 5, maxLength: 80 },
					],
				},
			],
			prompts: [
				{ id: "topics", field: "target.topics", trigger: "task.open", label: "Choose topics" },
			],
			classification: { threshold: 0.9, instructions: "Is this a study session?" },
			view: (_, data) => data,
		},
	],
};

const health: TaskPlugin = {
	id: "health",
	label: "Health",
	subtypes: [
		{
			id: "health.ride",
			label: "Ride",
			schemaVersion: 1,
			schema: z.strictObject({ actualMinutes: z.number().positive().optional() }),
			initialData: {},
			editor: [
				{ fields: [{ key: "actualMinutes", label: "Actual minutes", kind: "number", min: 1 }] },
			],
			classification: { threshold: 0.9, instructions: "Is this a workout?" },
			view: (_, data) => data,
		},
	],
	features: [
		{
			id: "health.view-meals",
			label: "View meals on workout day",
			subtypeId: "health.ride",
			requires: { id: "nutrition.logged-meal", version: 1 },
			scope: "local-day",
		},
	],
};

it("resolves distinct prerequisite facts for an unscheduled study session within its task scope", async () => {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	await runInDurableObject(stub, async (_, state) => {
		const db = new SqlitePlannerDatabase(drizzle(state.storage));
		const pluginDb = new SqliteTaskPluginDatabase(drizzle(state.storage));
		const planner = new Planner(db);
		const graph: TaskPlugin = {
			id: "graph",
			label: "Graph",
			subtypes: [],
			facts: [{ id: "graph.prerequisites", version: 1, scopes: ["task"] }],
		};
		const feature = {
			id: "study.show-prerequisites",
			label: "Show prerequisites",
			subtypeId: "study.session",
			requires: graph.facts![0],
			scope: "task" as const,
		};
		const session = planner.create(createTask.parse({ title: "Study databases" }));
		const index = planner.create(createTask.parse({ title: "Read index chapter" }));
		const keys = planner.create(createTask.parse({ title: "Read keys chapter" }));
		planner.setDependency({ from: index.id, to: session.id }, true);
		planner.setDependency({ from: keys.id, to: session.id }, true);
		const registry = new TaskPlugins(db, pluginDb, [graph, { ...study, features: [feature] }], {
			grantEpoch: (consumer, fact, scope) =>
				consumer === "study" &&
				fact.id === "graph.prerequisites" &&
				scope.kind === "task" &&
				scope.taskId === session.id
					? "allowed"
					: undefined,
			reader: () => async (scope) => {
				if (scope.kind !== "task") return [];
				const rows = planner.traverse(scope.taskId, "ancestors").map((id) => ({
					id: scope.taskId + "/requires/" + id,
					scope,
					value: planner.get(id).title,
				}));
				return [
					...rows,
					...rows,
					{ id: "other-task", scope: { kind: "task", taskId: keys.id }, value: "out of scope" },
				];
			},
		});
		registry.setEnabled("graph", true);
		registry.setEnabled("study", true);
		registry.write(session.id, "study.session", { revision: null, data: {} });
		expect(registry.featureActions(session.id)).toEqual([{ id: feature.id, label: feature.label }]);
		const facts = await registry.runFeature(session.id, feature.id);
		expect(facts.map((record) => record.value).sort()).toEqual([index.title, keys.title]);
	});
});

it("projects missing fields from enabled, matching subtype versions throughout a task's lifecycle", async () => {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	await runInDurableObject(stub, (_, state) => {
		const db = new SqlitePlannerDatabase(drizzle(state.storage));
		const pluginDb = new SqliteTaskPluginDatabase(drizzle(state.storage));
		const registry = new TaskPlugins(db, pluginDb, [study, nutritionPlugin]);
		const planner = new Planner(db);
		const task = planner.create(createTask.parse({ title: "Study during lunch" }));
		const prompts = (skipped?: ReadonlySet<string>) =>
			eligibleTaskPrompts(registry.details(task.id), registry.installations(), skipped);
		expect(prompts()).toEqual([]);
		registry.setEnabled("nutrition", true);
		registry.setEnabled("study", true);
		registry.store(task.id, mealType, "automatic", {}, task.title);
		const session = registry.write(task.id, "study.session", { data: {}, revision: null });
		expect(prompts()).toEqual([
			{
				id: "study.session.topics",
				typeId: "study.session",
				field: "target.topics",
				label: "Choose topics",
				trigger: "task.open",
			},
		]);
		registry.write(task.id, session.typeId, {
			data: { target: { topics: ["Indexes"] } },
			revision: session.revision,
		});
		expect(prompts()).toEqual([]);
		planner.update(task.id, { revision: task.revision, completed: true });
		expect(prompts().map(({ id }) => id)).toEqual(["nutrition.meal.foods"]);
		expect(prompts(new Set(["nutrition.meal.foods"]))).toEqual([]);
		registry.setEnabled("nutrition", false);
		expect(prompts()).toEqual([]);
		registry.setEnabled("nutrition", true);
		const details = registry.details(task.id);
		expect(
			eligibleTaskPrompts(
				{ ...details, subtypes: details.subtypes.map((s) => ({ ...s, schemaVersion: 2 })) },
				registry.installations(),
			),
		).toEqual([]);
		const meal = details.subtypes.find((s) => s.typeId === mealType.id)!;
		const confirmed = registry.write(task.id, meal.typeId, {
			revision: meal.revision,
			data: { foods: ["Rice"] },
		});
		expect(prompts()).toEqual([]);
		registry.write(task.id, meal.typeId, { revision: confirmed.revision, data: null });
		expect(prompts()).toEqual([]);
	});
});

it.each([false, true])(
	"refreshes a permitted, compatible peer fact from the current local day (provider first %s)",
	async (providerFirst) => {
		const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
		await runInDurableObject(stub, async (_, state) => {
			const db = new SqlitePlannerDatabase(drizzle(state.storage));
			const pluginDb = new SqliteTaskPluginDatabase(drizzle(state.storage));
			const planner = new Planner(db);
			const day = "2026-11-24",
				timeZone = "America/Toronto";
			let grant: string | undefined;
			let duringRead = () => {};
			const access: PluginFactAccess = {
				grantEpoch: (consumer, fact, scope) =>
					consumer === "health" &&
					fact.id === "nutrition.logged-meal" &&
					scope.kind === "local-day" &&
					scope.day === day
						? grant
						: undefined,
				reader: (fact) =>
					fact.id !== "nutrition.logged-meal" || fact.version !== 1
						? undefined
						: async (scope) => {
								if (scope.kind !== "local-day") return [];
								const matches = db.search({ date: scope.day, completed: true, limit: 50 }).tasks;
								const rows = matches.flatMap((task) => {
									const meal = pluginDb
										.subtypes(task.id, task.title)
										.find((s) => s.typeId === mealType.id);
									if (meal?.source !== "manual" || !meal.data?.foods) return [];
									return [{ id: task.id + "/foods", scope, value: meal.data.foods }];
								});
								duringRead();
								return [...rows, ...rows]; // Replayed facts carry the same identity.
							},
			};
			const registry = new TaskPlugins(db, pluginDb, [health, nutritionPlugin], access);
			if (providerFirst) registry.setEnabled("nutrition", true);
			registry.setEnabled("health", true);
			const ride = planner.create(
				createTask.parse({
					title: "Evening ride",
					completed: true,
					schedule: {
						type: "fixed",
						start: "2026-11-25T01:00:00Z",
						end: "2026-11-25T01:30:00Z",
					},
				}),
			);
			registry.write(ride.id, "health.ride", { revision: null, data: { actualMinutes: 30 } });
			const actions = () => registry.featureActions(ride.id, timeZone);
			const run = () => registry.runFeature(ride.id, "health.view-meals", timeZone);
			expect(actions()).toEqual([]);
			registry.setEnabled("nutrition", true);
			expect(actions()).toEqual([]);
			grant = "granted";
			expect(actions()).toEqual([{ id: "health.view-meals", label: "View meals on workout day" }]);
			expect(await run()).toEqual([]);
			const dinner = planner.create(
				createTask.parse({
					title: "Dinner",
					schedule: { type: "day", date: day },
					completed: true,
				}),
			);
			const tentative = registry.store(dinner.id, mealType, "automatic", {}, dinner.title);
			expect(await run()).toEqual([]);
			const meal = registry.write(dinner.id, mealType.id, {
				revision: tentative.revision,
				data: { foods: ["Soup"] },
			});
			const mealFact = { id: dinner.id + "/foods", scope: { kind: "local-day", day, timeZone } };
			expect(await run()).toEqual([{ ...mealFact, value: ["Soup"] }]);
			registry.write(dinner.id, mealType.id, {
				revision: meal.revision,
				data: { foods: ["Salad"] },
			});
			expect(await run()).toEqual([{ ...mealFact, value: ["Salad"] }]);
			expect(registry.featureActions(ride.id, "UTC")).toEqual([]);
			duringRead = () => {
				registry.setEnabled("nutrition", false);
			};
			await expect(run()).rejects.toMatchObject({ status: 409 });
			expect(actions()).toEqual([]);
			expect(registry.details(ride.id).subtypes[0].data).toEqual({ actualMinutes: 30 });
			duringRead = () => {};
			registry.setEnabled("nutrition", true);
			expect(await run()).toEqual([{ ...mealFact, value: ["Salad"] }]);
			const upgraded = new TaskPlugins(
				db,
				pluginDb,
				[
					health,
					{
						...nutritionPlugin,
						facts: [{ id: "nutrition.logged-meal", version: 2, scopes: ["local-day"] }],
					},
				],
				access,
			);
			expect(upgraded.featureActions(ride.id, timeZone)).toEqual([]);
			grant = undefined;
			await expect(run()).rejects.toMatchObject({ status: 404 });
		});
	},
);
