import { z } from "zod";
import { task, type Task } from "./plan.ts";

export const pluginId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const subtypeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/);
// The wire envelope carries an object. Each registered subtype validates its fields.
const subtypeData = z.record(z.string(), z.unknown());

export const taskSubtype = z.strictObject({
	typeId: subtypeId,
	schemaVersion: z.int().positive(),
	revision: z.uuid(),
	source: z.enum(["automatic", "manual"]),
	// A null payload records an explicit rejection.
	data: subtypeData.nullable(),
});

export const taskDetails = z.strictObject({
	task,
	subtypes: z.array(taskSubtype),
	classification: z.enum(["idle", "pending", "failed"]),
	lastClassification: z.strictObject({
		checkedAt: z.iso.datetime(),
		evaluated: z.array(subtypeId),
		matched: z.array(subtypeId),
	}).optional(),
});

export const writeTaskSubtype = z.strictObject({
	revision: z.uuid().nullable(),
	data: subtypeData.nullable(),
});

const fieldKey = z.string().regex(/^[a-z][a-zA-Z0-9]*$/);
export const taskTypeIcon = z.enum(["tag", "utensils", "book", "calendar", "card", "activity"]);
export type TaskTypeIconName = z.infer<typeof taskTypeIcon>;
const prompt = z.strictObject({
	id: pluginId,
	field: z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)?$/),
	label: z.string().min(1),
	trigger: z.enum(["task.open", "task.completed"]),
});
export const eligibleTaskPrompt = prompt.extend({
	id: z.string(),
	typeId: subtypeId,
});
export type EligibleTaskPrompt = z.infer<typeof eligibleTaskPrompt>;
const field = { key: fieldKey, label: z.string(), inlayLabel: z.string().min(1).optional() };
const subtypeField = z.discriminatedUnion("kind", [
	z.strictObject({
		...field,
		kind: z.literal("text-list"),
		maxItems: z.int().positive(),
		maxLength: z.int().positive(),
	}),
	z.strictObject({ ...field, kind: z.literal("number"), min: z.number() }),
]);
const subtypeEditor = z.array(
	z.strictObject({
		key: fieldKey.optional(),
		label: z.string().optional(),
		requiredTogether: z.boolean().optional(),
		fields: z.array(subtypeField),
	}),
);

export const pluginInstallation = z.strictObject({
	id: pluginId,
	label: z.string(),
	enabled: z.boolean(),
	subtypes: z.array(
		z.strictObject({
			id: subtypeId,
			label: z.string(),
			icon: taskTypeIcon.optional(),
			captureCommand: pluginId.optional(),
			schemaVersion: z.int().positive(),
			editor: subtypeEditor.optional(),
			prompts: z.array(prompt).optional(),
			initialData: subtypeData.optional(),
		}),
	),
});
export const pluginInstallations = z.array(pluginInstallation);
export const writePluginInstallation = z.strictObject({ enabled: z.boolean() });

export type TaskSubtype = z.infer<typeof taskSubtype>;
export type TaskDetails = z.infer<typeof taskDetails>;
export type WriteTaskSubtype = z.infer<typeof writeTaskSubtype>;
export type TaskPluginInstallation = z.infer<typeof pluginInstallation>;
export type TaskSubtypeEditor = z.infer<typeof subtypeEditor>;

/** Prompts describe missing fields. Recompute against the latest task so arrival order is irrelevant. */
export function eligibleTaskPrompts(
	details: Pick<TaskDetails, "task" | "subtypes">,
	installations: readonly TaskPluginInstallation[],
	skipped?: ReadonlySet<string>,
): EligibleTaskPrompt[] {
	const active = new Map(details.subtypes.map((s) => [s.typeId, s]));
	const trigger = details.task.completed ? "task.completed" : "task.open";
	const result: EligibleTaskPrompt[] = [];
	for (const plugin of installations) {
		if (!plugin.enabled) continue;
		for (const type of plugin.subtypes) {
			const subtype = active.get(type.id);
			if (!subtype?.data || subtype.schemaVersion !== type.schemaVersion) continue;
			for (const prompt of type.prompts ?? []) {
				const id = type.id + "." + prompt.id;
				if (prompt.trigger !== trigger || skipped?.has(id)) continue;
				const [key, child] = prompt.field.split(".");
				const parent = subtype.data[key];
				const value =
					child && parent && typeof parent === "object"
						? (parent as Record<string, unknown>)[child]
						: parent;
				if (value == null || value === "" || (Array.isArray(value) && !value.length))
					result.push({ ...prompt, id, typeId: type.id });
			}
		}
	}
	return result;
}

export interface TaskSubtypeDefinition<Data extends NonNullable<TaskSubtype["data"]>, View> {
	readonly id: string;
	readonly label: string;
	readonly icon?: TaskTypeIconName;
	readonly captureCommand?: string;
	readonly schemaVersion: number;
	readonly schema: z.ZodType<Data>;
	readonly initialData: Data;
	readonly classification: { readonly instructions: string; readonly threshold: number };
	readonly editor?: TaskSubtypeEditor;
	readonly prompts?: z.infer<typeof prompt>[];
	view(task: Task, data: Data): View;
}

export interface TaskPlugin {
	readonly id: string;
	readonly label: string;
	readonly subtypes: readonly TaskSubtypeDefinition<NonNullable<TaskSubtype["data"]>, unknown>[];
	readonly facts?: readonly PluginFact[];
	readonly features?: readonly PluginFeature[];
}

export type FactScope =
	| { kind: "task"; taskId: string }
	| { kind: "local-day"; day: string; timeZone: string };

export interface PluginFactRef {
	readonly id: string;
	readonly version: number;
}

export interface PluginFact extends PluginFactRef {
	readonly scopes: readonly FactScope["kind"][];
}

/** A contextual action on one subtype that displays a permissioned fact from a peer. */
export interface PluginFeature {
	readonly id: string;
	readonly label: string;
	readonly subtypeId: string;
	readonly requires: PluginFactRef;
	readonly scope: FactScope["kind"];
}

export type PluginFactRecord = { id: string; scope: FactScope; value: unknown };

/** Bound to a single planner. An absent grant or reader leaves the feature unavailable. */
export interface PluginFactAccess {
	grantEpoch(consumer: string, fact: PluginFact, scope: FactScope): string | undefined;
	reader(
		fact: PluginFact,
	): ((scope: FactScope) => Promise<readonly PluginFactRecord[]>) | undefined;
}

export function asTaskSubtype<Data extends NonNullable<TaskSubtype["data"]>, View>(
	details: TaskDetails,
	definition: TaskSubtypeDefinition<Data, View>,
): View | undefined {
	const subtype = details.subtypes.find(({ typeId }) => typeId === definition.id);
	if (!subtype?.data || subtype.schemaVersion !== definition.schemaVersion) return;
	const data = definition.schema.safeParse(subtype.data);
	if (data.success) return definition.view(details.task, data.data);
}
