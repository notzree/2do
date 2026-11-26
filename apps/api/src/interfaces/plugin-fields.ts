import { z } from "zod";
import { classificationThreshold } from "./task-classifier.ts";
import { fieldName } from "./subtype-field-values.ts";
import {
	pluginInstallation,
	type TaskSubtypeDefinition,
	type TaskSubtypeEditor,
} from "./task-plugins.ts";
import type { PluginData } from "./plugin-workflows.ts";

type Field = TaskSubtypeEditor[number]["fields"][number];
type Options<Kind> = Omit<Extract<Field, { kind: Kind }>, "kind">;

/** A single declaration supplies the API validator and the editable field's limits. */
export function numberField<const Key extends string>(options: Options<"number"> & { key: Key }) {
	return {
		schema: z.number().min(options.min),
		field: { ...options, kind: "number" as const },
	};
}

export function textField<const Key extends string>(options: Options<"text"> & { key: Key }) {
	return {schema:z.string().trim().min(1).max(options.maxLength),field:{...options,kind:"text" as const}};
}
export function choiceField<const Key extends string>(options: Options<"choice"> & { key: Key }) {
	return {schema:z.enum(options.options),field:{...options,kind:"choice" as const}};
}
export function textListField<const Key extends string>(
	options: Options<"text-list"> & { key: Key },
) {
	return {
		schema: z.array(z.string().trim().min(1).max(options.maxLength)).max(options.maxItems),
		field: { ...options, kind: "text-list" as const },
	};
}

// Strip server-only rules and methods using the same allowlist the wire contract publishes.
const publicSubtype = z.object(pluginInstallation.shape.subtypes.element.shape);

export function describeSubtype<Data extends PluginData, View>(
	definition: TaskSubtypeDefinition<Data, View>,
) {
	return publicSubtype.parse({
		...definition,
		captureAliases: definition.captureAliases && Object.keys(definition.captureAliases),
		classification: { ...definition.classification, threshold: classificationThreshold },
		actions: definition.workflow?.commands,
	});
}

type JsonSchema = z.core.JSONSchema.JSONSchema;
type Node = JsonSchema | boolean | undefined;

function branches(root: JsonSchema, node: Node, seen = new Set<JsonSchema>()): JsonSchema[] {
	if (!node || typeof node !== "object" || seen.has(node)) return [];
	seen.add(node);
	const ref =
		node.$ref === "#"
			? root
			: node.$ref?.startsWith("#/$defs/")
				? root.$defs?.[node.$ref.slice("#/$defs/".length)]
				: undefined;
	return [
		node,
		...[ref, ...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])].flatMap((child) =>
			branches(root, child, seen),
		),
	];
}

function editorSchemas(root: JsonSchema, path: string) {
	let candidates = branches(root, root);
	for (const key of path.split(".")) {
		candidates = candidates.flatMap((node) =>
			branches(root, node.properties?.[key] ?? node.additionalProperties),
		);
	}
	return candidates;
}

function acceptedTypes(nodes: JsonSchema[]): string[] {
	return nodes.flatMap(({ type }) => type ?? []);
}

function supportsField(root: JsonSchema, path: string, field: Field) {
	const nodes = editorSchemas(root, path);
	const types = acceptedTypes(nodes).filter((type) => type !== "null");
	if (!types.length) return false;
	if (field.kind === "text" || field.kind === "choice") return types.every(type=>type === "string");
	if (field.kind === "number")
		return types.every((type) => type === "number" || type === "integer");
	if (!types.every((type) => type === "array")) return false;
	const itemTypes = acceptedTypes(
		nodes.flatMap(({ items }) =>
			(Array.isArray(items) ? items : [items]).flatMap((item) => branches(root, item)),
		),
	);
	return itemTypes.length > 0 && itemTypes.every((type) => type === "string");
}

export function validateSubtypeDefinition<Data extends PluginData, View>(
	definition: TaskSubtypeDefinition<Data, View>,
) {
	const manifest = describeSubtype(definition);
	definition.schema.parse(definition.initialData);
	for (const preset of Object.values(definition.captureAliases ?? {})) definition.schema.parse({...definition.initialData,...preset});
	const paths = new Set<string>();
	if (manifest.editor?.some((group) => group.fields.length)) {
		// Optional/default/nullable wrappers, objects and unions retain their public JSON shape.
		// An unrelated custom transform can remain opaque as long as its field is not editable.
		const root = z.toJSONSchema(definition.schema, { io: "input", unrepresentable: "any" });
		for (const group of manifest.editor) {
			for (const field of group.fields) {
				const path = fieldName(group, field);
				if (paths.has(path)) throw new Error("Duplicate editor field " + manifest.id + "." + path);
				if (!supportsField(root, path, field))
					throw new Error(
						"Schema does not define a " +
							field.kind +
							" editor field at " +
							manifest.id +
							"." +
							path,
					);
				paths.add(path);
			}
		}
	}
	for (const [path, instructions] of Object.entries(definition.extraction ?? {})) {
		if (!paths.has(path) || !instructions.trim()) throw new Error("Invalid extraction field " + path);
	}
	const promptIds = new Set<string>();
	for (const prompt of manifest.prompts ?? []) {
		if (promptIds.has(prompt.id) || !paths.has(prompt.field))
			throw new Error("Invalid or duplicate prompt " + manifest.id + "." + prompt.id);
		promptIds.add(prompt.id);
	}
}
