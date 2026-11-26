import { env } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { z } from "zod";
import {
	describeSubtype,
	numberField,
	textListField,
	validateSubtypeDefinition,
} from "../src/interfaces/plugin-fields.ts";
import { pluginInstallations, type TaskSubtypeDefinition } from "../src/interfaces/task-plugins.ts";

const topics = textListField({ key: "topics", label: "Topics", maxLength: 5, maxItems: 2 });
const pages = numberField({ key: "pages", label: "Pages", min: 0 });
const data = z.strictObject({
	topics: topics.schema.optional(),
	target: z.strictObject({ pages: pages.schema.int() }).nullable().optional(),
});
const definition: TaskSubtypeDefinition<z.infer<typeof data>, null> = {
	id: "study.read",
	label: "Read",
	schemaVersion: 1,
	schema: data,
	initialData: {},
	classification: { instructions: "Is it reading?" },
	editor: [{ fields: [topics.field] }, { key: "target", fields: [pages.field] }],
	prompts: [{ id: "pages", trigger: "task.open", label: "Pages?", field: "target.pages" }],
	view: () => null,
};

it("uses the same primitive limits for input validation and displayed fields", () => {
	validateSubtypeDefinition(definition);
	expect(topics.schema.parse([" one "])).toEqual(["one"]);
	expect(topics.schema.safeParse(["a", "b", "c"]).success).toBe(false);
	expect(topics.schema.safeParse(["longer"]).success).toBe(false);
	expect(data.safeParse({ target: { pages: 0 } }).success).toBe(true);
	expect(data.safeParse({ target: { pages: -1 } }).success).toBe(false);
	expect(describeSubtype(definition)).toMatchObject({
		classification: definition.classification,
		editor: definition.editor,
	});
	expect(describeSubtype(definition)).not.toHaveProperty("schema");
	expect(describeSubtype(definition)).not.toHaveProperty("view");
});

it("rejects undeclared paths, duplicate fields or prompts, incompatible types and empty classification instructions", () => {
	const fields = (list: typeof definition.editor) =>
		validateSubtypeDefinition({ ...definition, editor: list });
	expect(() => fields([{ key: "target", fields: [topics.field] }])).toThrow(/target.topics/);
	expect(() => fields([{ fields: [topics.field, topics.field] }])).toThrow(
		/Duplicate editor field/,
	);
	expect(() => fields([{ fields: [{ ...pages.field, key: "topics" }] }])).toThrow(
		/number editor field/,
	);
	expect(() =>
		validateSubtypeDefinition({
			...definition,
			prompts: [definition.prompts![0], definition.prompts![0]],
		}),
	).toThrow(/duplicate prompt/);
	expect(() =>
		validateSubtypeDefinition({
			...definition,
			classification: { instructions: "" },
		}),
	).toThrow();
	expect(() =>
		validateSubtypeDefinition({
			...definition,
			schema: z.strictObject({ topics: z.array(z.number()).optional() }),
			initialData: {},
			view: () => null,
			workflow: undefined,
			fromTitle: undefined,
			captureAliases: undefined,
		}),
	).toThrow(/text-list editor field/);
});

it("serves a disabled plugin's public capabilities before it is enabled", async () => {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	const response = await stub.fetch("https://planner.test/api/task-plugins");
	expect(response.status).toBe(200);
	const nutrition = pluginInstallations
		.parse(await response.json())
		.find((p) => p.id === "nutrition");
	expect(nutrition).toMatchObject({
		enabled: false,
		description: expect.any(String),
		metrics: expect.arrayContaining([
			{ id: "nutrition.protein", label: "Protein", unit: "g", version: 1, reducer: "sum" },
		]),
		subtypes: [
			{
				id: "nutrition.meal",
				captureCommand: "meal",
				actions: expect.arrayContaining([
					expect.objectContaining({ id: "confirm", label: "Confirm meal" }),
					expect.objectContaining({ id: "estimate", fields: [
						expect.objectContaining({ kind: "text", key: "note" }),
						expect.objectContaining({ kind: "image", key: "photo" }),
					] }),
				]),
				classification: { threshold: 0.5, instructions: expect.any(String) },
			},
		],
	});
	expect(nutrition?.subtypes[0]).not.toHaveProperty("workflow");
});
