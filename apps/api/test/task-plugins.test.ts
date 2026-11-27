import { drizzle } from "drizzle-orm/durable-sqlite";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { ClefTaskClassifier } from "../src/classifiers/clef.ts";
import { Planner } from "../src/core/planner.ts";
import { TaskClassification } from "../src/core/task-classification.ts";
import { TaskPlugins } from "../src/core/task-plugins.ts";
import { SqlitePlannerDatabase } from "../src/db/planner.ts";
import { SqliteTaskPluginDatabase } from "../src/db/task-plugins.ts";
import { createTask } from "../src/interfaces/plan.ts";
import { asTaskSubtype, taskDetails } from "../src/interfaces/task-plugins.ts";
import { mealType, nutritionPlugin } from "../src/plugins/meal.ts";

it("classifies notebook tasks in one batch and preserves a user answer across plugin toggles", async () => {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	const call = (path: string, method = "GET", value?: object) =>
		stub.fetch("https://planner.test/api/" + path, {
			method,
			...(value && {
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(value),
			}),
		});
	const details = async (id: string) =>
		taskDetails.parse(await (await call("tasks/" + id + "/details")).json());

	expect((await call("task-plugins/nutrition", "PUT", { enabled: true })).status).toBe(200);
	const rawInput = "Check the schedule with everyone. ".repeat(8) + "Get dinner at Nuri Village";
	const dinner = { id: crypto.randomUUID(), title: rawInput.slice(0, 239) + "…", rawInput };
	expect(dinner.title).not.toContain("dinner");
	const groceries = { id: crypto.randomUUID(), title: "Shop for groceries" };
	const date = "2026-11-24";
	const write = {
		version: 1,
		revision: 0,
		newTasks: [dinner, groceries],
		doc: {
			type: "doc",
			content: [dinner, groceries].map(({ id }) => ({ type: "taskRef", attrs: { id } })),
		},
	};
	const missing = { type: "taskRef", attrs: { id: crypto.randomUUID() } };
	expect(
		(
			await call("days/" + date, "PUT", {
				...write,
				doc: { ...write.doc, content: [...write.doc.content, missing] },
			})
		).status,
	).toBe(404);
	expect((await call("tasks/" + dinner.id)).status).toBe(404);
	expect((await call("days/" + date, "PUT", write)).status).toBe(200);
	expect(
		(
			await call("tasks/" + dinner.id, "PATCH", {
				completed: true,
				revision: (await details(dinner.id)).task.revision,
			})
		).status,
	).toBe(200);

	async function finishClassification() {
		await runInDurableObject(stub, async (instance, state) => {
			state.storage.sql.exec("UPDATE task_classification SET due = 0");
			expect.assert(instance.alarm);
			await instance.alarm();
		});
	}
	await finishClassification();

	const loaded = await details(dinner.id);
	expect((await call("tasks/" + dinner.id + "/classify", "POST")).status).toBe(202);
	await finishClassification();
	expect((await details(dinner.id)).lastClassification?.matched).toEqual([mealType.id]);
	expect(loaded.task.completed).toBe(true);
	expect(loaded.classification).toBe("idle");
	expect(loaded.subtypes).toHaveLength(1);
	expect(loaded.subtypes[0]).toMatchObject({ typeId: mealType.id, source: "automatic", data: {} });
	expect((await details(groceries.id)).subtypes).toEqual([]);
	expect(asTaskSubtype(loaded, mealType)?.nutrition()).toBeUndefined();

	await call("task-plugins/nutrition", "PUT", { enabled: false });
	await call("tasks/" + dinner.id, "PATCH", {
		revision: loaded.task.revision,
		title: "Wash the car",
	});
	await call("task-plugins/nutrition", "PUT", { enabled: true });
	expect((await details(dinner.id)).subtypes).toEqual([]);
	await finishClassification();
	expect(await details(dinner.id)).toMatchObject({ subtypes: [], classification: "idle" });
	await runInDurableObject(stub, (_, state) => {
		expect(
			state.storage.sql
				.exec("SELECT taskId FROM task_subtype WHERE taskId = ?", dinner.id)
				.toArray(),
		).toEqual([]);
	});
	await call("tasks/" + dinner.id, "PATCH", {
		revision: (await details(dinner.id)).task.revision,
		title: "Get dinner at Nuri Village",
	});
	await finishClassification();
	const subtypePath = "tasks/" + dinner.id + "/subtypes/" + mealType.id;
	const revision = (await details(dinner.id)).subtypes[0].revision;
	expect(
		(await call(subtypePath, "PUT", { revision, data: { foods: [], unsupported: true } })).status,
	).toBe(400);
	expect((await call(subtypePath, "PUT", { revision, data: { foods: ["Bibimbap"] } })).status).toBe(
		200,
	);
	expect((await call(subtypePath, "PUT", { revision, data: null })).status).toBe(409);

	await call("task-plugins/nutrition", "PUT", { enabled: false });
	expect((await details(dinner.id)).subtypes).toEqual([]);
	await call("task-plugins/nutrition", "PUT", { enabled: true });
	expect(asTaskSubtype(await details(dinner.id), mealType)?.foods()).toEqual(["Bibimbap"]);
});

it("selects one eligible subtype above 0.5 and rejects results from superseded titles or installs", async () => {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	await runInDurableObject(stub, async (_instance, state) => {
		const db = new SqlitePlannerDatabase(drizzle(state.storage));
		const pluginDb = new SqliteTaskPluginDatabase(drizzle(state.storage));
		const expenseType = { ...mealType, id: "budget.expense" };
		const receiptType = { ...mealType, id: "budget.receipt" };
		const plugins = new TaskPlugins(db, pluginDb, [
			nutritionPlugin,
			{
				id: "budget",
				label: "Budget",
				subtypes: [expenseType, receiptType],
			},
		]);
		const planner = new Planner(db, (task, previous, rawInput) => {
			if (task.title !== previous?.title) classification.enqueue(task, 0, rawInput);
		});
		const providerInputs: string[] = [];
		const scores: Record<string, number> = {
			[mealType.id]: 0.6,
			[expenseType.id]: 0.83,
			[receiptType.id]: 0.79,
		};
		let inFlight = () => {};
		const classification = new TaskClassification(db, plugins, {
			async classify(inputs) {
				providerInputs.push(...inputs.map((input) => input.title));
				inFlight();
				return inputs.map(({ taskId, candidates }) => ({
					taskId,
					scores: Object.fromEntries(candidates.map(({ typeId }) => [typeId, scores[typeId]])),
				}));
			},
		});
		const process = () => classification.processDue(async (write) => db.transaction(write), 1_000);
		plugins.setEnabled("nutrition", true);
		plugins.setEnabled("budget", true);
		const rawInput = "Discuss the project. ".repeat(16) + "Get dinner";
		const dinner = planner.create(
			createTask.parse({ title: rawInput.slice(0, 239) + "…" }),
			rawInput,
		);
		inFlight = () => {
			planner.update(dinner.id, { revision: planner.get(dinner.id).revision, title: "Get lunch" });
		};
		await process();
		expect(providerInputs).toEqual([rawInput]);
		expect(plugins.details(dinner.id)).toMatchObject({ subtypes: [], classification: "pending" });

		inFlight = () => {
			plugins.setEnabled("budget", false);
			plugins.setEnabled("budget", true);
		};
		await process();
		expect(providerInputs).toEqual([rawInput, "Get lunch"]);
		expect(plugins.details(dinner.id).subtypes.map(({ typeId }) => typeId)).toEqual([mealType.id]);

		inFlight = () => {};
		planner.update(dinner.id, {
			revision: planner.get(dinner.id).revision,
			title: "Get lunch at Nuri Village",
		});
		await process();
		const details = () => plugins.details(dinner.id);
		const automaticIds = () => details().subtypes.filter((s) => s.source === "automatic").map((s) => s.typeId);
		expect(automaticIds()).toEqual([expenseType.id]);
		expect(details().lastClassification?.matched).toEqual([expenseType.id]);

		const recheck = async () => {
			classification.request(dinner.id);
			await classification.processDue(async (write) => db.transaction(write));
		};
		scores[expenseType.id] = 0.5;
		scores[mealType.id] = 0.49;
		scores[receiptType.id] = 0.1;
		await recheck();
		expect(automaticIds()).toEqual([]);
		expect(details().lastClassification?.matched).toEqual([]);

		scores[mealType.id] = 0.5001;
		scores[expenseType.id] = 0.5001;
		await recheck();
		expect(automaticIds()).toEqual([mealType.id]);

		plugins.setEnabled("nutrition", false);
		await recheck();
		expect(automaticIds()).toEqual([expenseType.id]);
		plugins.setEnabled("nutrition", true);
		expect(details().classification).toBe("pending");
		await classification.processDue(async (write) => db.transaction(write));
		expect(automaticIds()).toEqual([mealType.id]);

		const meal = plugins.details(dinner.id).subtypes.find(({ typeId }) => typeId === mealType.id)!;
		plugins.write(dinner.id, mealType.id, { revision: meal.revision, data: null });
		planner.update(dinner.id, {
			revision: planner.get(dinner.id).revision,
			title: "Another title",
		});
		await process();
		expect(
			plugins.details(dinner.id).subtypes.find(({ typeId }) => typeId === mealType.id)?.data,
		).toBeNull();

		expect(automaticIds()).toEqual([expenseType.id]);

		const second = planner.create(
			createTask.parse({ title: "Travel plan" }),
			"Travel plan with dinner",
		);
		plugins.setEnabled("nutrition", false);
		plugins.setEnabled("budget", false);
		planner.update(second.id, { revision: second.revision, title: "Book flights" });
		plugins.setEnabled("nutrition", true);
		await process();
		expect(providerInputs.at(-1)).toBe("Book flights");

		plugins.setEnabled("budget", true);
		const paidLunch = planner.create(createTask.parse({ title: "Paid for lunch" }));
		const selected = plugins.attachAtCapture(paidLunch.id, mealType.id);
		scores[mealType.id] = 0.99;
		scores[expenseType.id] = 0.9;
		await process();
		expect(plugins.details(paidLunch.id)).toMatchObject({
			subtypes: [selected],
			lastClassification: {
				evaluated: [mealType.id, expenseType.id, receiptType.id],
				matched: [mealType.id],
			},
		});
		scores[mealType.id] = 0.7;
		classification.request(paidLunch.id);
		await classification.processDue(async (write) => db.transaction(write));
		expect(plugins.details(paidLunch.id)).toMatchObject({
			subtypes: [{ typeId: expenseType.id, source: "automatic" }, selected],
			lastClassification: { matched: [expenseType.id] },
		});
	});
});

it("classifies with the same raw response mode as a streaming Copilot call", async () => {
	const signal = new AbortController().signal;
	const classifier = ClefTaskClassifier.using({
		async run(model, _input, options) {
			expect(model).toBe("@cf/cloudflare/clef-flash");
			expect(options).toEqual({ returnRawResponse: true, signal });
			return Response.json({ answers: { q0: { noul: 0.96 } } });
		},
	});
	const task = {
		taskId: "lunch",
		title: "Have lunch",
		candidates: [{ typeId: "meal", instructions: "Eating a meal" }],
	};
	expect(await classifier.classify([task], signal)).toEqual([
		{ taskId: "lunch", scores: { meal: 0.96 } },
	]);
});

it("keeps each task in its own Clef state and sends every eligible subtype in groups of 64", async () => {
	const candidates = Array.from({ length: 65 }, (_, i) => ({
		typeId: "test.type-" + i,
		instructions: "Rule " + i,
	}));
	const calls = new Map<string, string[][]>();
	const classifier = new ClefTaskClassifier(async ({ model, state, questions }) => {
		expect(model).toBe("clef-flash");
		const rules = Object.values(questions).map(({ type, instructions }) => {
			expect(type).toBe("noul");
			return instructions;
		});
		calls.set(state, [...(calls.get(state) ?? []), rules]);
		return {
			answers: Object.fromEntries(
				Object.entries(questions).map(([key, question]) => [
					key,
					{ noul: state === "Team lunch" ? Number(question.instructions.slice(5)) / 100 : 0.99 },
				]),
			),
		};
	});
	const results = await classifier.classify([
		{ taskId: "meal", title: "Team lunch", candidates },
		{ taskId: "errand", title: "Return a lunchbox", candidates: candidates.slice(0, 2) },
		{ taskId: "manual", title: "Already set", candidates: [] },
	]);
	const rules = candidates.map(({ instructions }) => instructions);
	expect(calls).toEqual(
		new Map([
			["Team lunch", [rules.slice(0, 64), rules.slice(64)]],
			["Return a lunchbox", [rules.slice(0, 2)]],
		]),
	);
	expect(results).toEqual([
		{
			taskId: "meal",
			scores: Object.fromEntries(candidates.map(({ typeId }, i) => [typeId, i / 100])),
		},
		{ taskId: "errand", scores: { "test.type-0": 0.99, "test.type-1": 0.99 } },
		{ taskId: "manual", scores: {} },
	]);
});

it("keeps a successful task when Clef omits a sibling task's answer", async () => {
	const candidates = [{ typeId: mealType.id, instructions: mealType.classification.instructions }];
	const classifier = new ClefTaskClassifier(async ({ state }) => ({
		answers: state === "Brunch" ? { q0: { noul: 0.96 } } : {},
	}));
	const failed = { taskId: "incomplete", title: "Groceries", candidates };
	expect(
		await classifier.classify([{ taskId: "complete", title: "Brunch", candidates }, failed]),
	).toEqual([{ taskId: "complete", scores: { [mealType.id]: 0.96 } }]);
	await expect(classifier.classify([failed])).rejects.toThrow("omitted");
});
