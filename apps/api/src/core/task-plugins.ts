import type { SqliteTaskPluginDatabase } from "../db/task-plugins.ts";
import type { PlannerDatabase } from "../interfaces/database.ts";
import type { Task } from "../interfaces/plan.ts";
import {
	pluginId,
	subtypeId,
	type FactScope,
	type PluginFactRecord,
	type PluginFactAccess,
	type PluginFeature,
	type TaskDetails,
	type TaskPlugin,
	type TaskSubtype,
	type TaskSubtypeDefinition,
	type WriteTaskSubtype,
} from "../interfaces/task-plugins.ts";
import { PlannerError } from "./planner.ts";

type Definition = TaskSubtypeDefinition<NonNullable<TaskSubtype["data"]>, unknown>;

function featureScope(
	kind: FactScope["kind"],
	task: Task,
	timeZone?: string,
): FactScope | undefined {
	if (kind === "task") return { kind, taskId: task.id };
	if (!task.schedule || !timeZone) return;
	const day =
		task.schedule.type === "day"
			? task.schedule.date
			: new Intl.DateTimeFormat("en-CA", {
					timeZone,
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
				}).format(new Date(task.schedule.start));
	return { kind, day, timeZone };
}

function sameScope(a: FactScope, b: FactScope): boolean {
	if (a.kind === "task") return b.kind === "task" && a.taskId === b.taskId;
	return b.kind === "local-day" && a.day === b.day && a.timeZone === b.timeZone;
}

export class TaskPlugins {
	private readonly types = new Map<string, { pluginId: string; definition: Definition }>();
	private readonly plugins = new Map<string, TaskPlugin>();
	private readonly features = new Map<string, { consumer: string; feature: PluginFeature }>();

	constructor(
		private readonly planner: Pick<PlannerDatabase, "task" | "transaction">,
		readonly db: SqliteTaskPluginDatabase,
		plugins: readonly TaskPlugin[],
		private readonly factAccess?: PluginFactAccess,
	) {
		for (const plugin of plugins) {
			pluginId.parse(plugin.id);
			if (this.plugins.has(plugin.id)) throw new Error("Duplicate task plugin " + plugin.id);
			this.plugins.set(plugin.id, plugin);
			const factIds = new Set<string>();
			for (const fact of plugin.facts ?? []) {
				subtypeId.parse(fact.id);
				if (
					!fact.id.startsWith(plugin.id + ".") ||
					factIds.has(fact.id) ||
					!Number.isSafeInteger(fact.version) ||
					fact.version < 1
				)
					throw new Error("Invalid or duplicate fact " + fact.id);
				factIds.add(fact.id);
			}
			for (const definition of plugin.subtypes) {
				subtypeId.parse(definition.id);
				if (definition.captureCommand !== undefined) pluginId.parse(definition.captureCommand);
				if (!definition.id.startsWith(plugin.id + ".") || this.types.has(definition.id)) {
					throw new Error("Invalid or duplicate task subtype " + definition.id);
				}
				definition.schema.parse(definition.initialData);
				const fields = new Set(
					definition.editor?.flatMap((group) =>
						group.fields.map((field) => (group.key ? group.key + "." + field.key : field.key)),
					),
				);
				const promptIds = new Set<string>();
				for (const prompt of definition.prompts ?? []) {
					pluginId.parse(prompt.id);
					if (!fields.has(prompt.field) || promptIds.has(prompt.id))
						throw new Error("Invalid or duplicate prompt " + definition.id + "." + prompt.id);
					promptIds.add(prompt.id);
				}
				this.types.set(definition.id, { pluginId: plugin.id, definition });
			}
			for (const feature of plugin.features ?? []) {
				subtypeId.parse(feature.id);
				subtypeId.parse(feature.requires.id);
				if (
					!feature.id.startsWith(plugin.id + ".") ||
					this.features.has(feature.id) ||
					this.types.get(feature.subtypeId)?.pluginId !== plugin.id ||
					!Number.isSafeInteger(feature.requires.version) ||
					feature.requires.version < 1
				)
					throw new Error("Invalid or duplicate feature " + feature.id);
				this.features.set(feature.id, { consumer: plugin.id, feature });
			}
		}
	}

	installations() {
		const enabled = this.db.installations();
		return Array.from(this.plugins.values(), (plugin) => ({
			id: plugin.id,
			label: plugin.label,
			enabled: enabled.has(plugin.id),
			subtypes: plugin.subtypes.map(
				({ id, label, icon, captureCommand, schemaVersion, editor, initialData, prompts }) => ({
					id,
					label,
					icon,
					captureCommand,
					schemaVersion,
					editor,
					initialData,
					prompts,
				}),
			),
		}));
	}

	private activeFeatures(id: string, timeZone?: string) {
		const access = this.factAccess;
		if (!access || !this.features.size) return [];
		const details = this.details(id);
		const installed = this.db.installations();
		return [...this.features.values()].flatMap(({ consumer, feature }) => {
			const host = this.types.get(feature.subtypeId)?.definition;
			if (
				!details.subtypes.some(
					(s) =>
						s.typeId === feature.subtypeId && s.data && s.schemaVersion === host?.schemaVersion,
				)
			)
				return [];
			const provider = feature.requires.id.split(".")[0];
			const consumerEpoch = installed.get(consumer);
			const providerEpoch = installed.get(provider);
			const fact = this.plugins
				.get(provider)
				?.facts?.find(
					({ id, version }) => id === feature.requires.id && version === feature.requires.version,
				);
			if (!consumerEpoch || !providerEpoch || !fact?.scopes.includes(feature.scope)) return [];
			const scope = featureScope(feature.scope, details.task, timeZone);
			if (!scope) return [];
			const grant = access.grantEpoch(consumer, fact, scope);
			const read = grant && access.reader(fact);
			return read ? [{ feature, scope, consumerEpoch, providerEpoch, grant, read }] : [];
		});
	}

	featureActions(id: string, timeZone?: string) {
		return this.activeFeatures(id, timeZone).map(({ feature }) => ({
			id: feature.id,
			label: feature.label,
		}));
	}

	async runFeature(id: string, actionId: string, timeZone?: string): Promise<PluginFactRecord[]> {
		const find = () =>
			this.activeFeatures(id, timeZone).find(({ feature }) => feature.id === actionId);
		const action = find();
		if (!action) throw new PlannerError(404, "Plugin action unavailable");
		const records = await action.read(action.scope);
		const current = find();
		if (
			!current ||
			!sameScope(current.scope, action.scope) ||
			current.grant !== action.grant ||
			current.consumerEpoch !== action.consumerEpoch ||
			current.providerEpoch !== action.providerEpoch
		)
			throw new PlannerError(409, "Plugin action changed while its facts were loading");
		const byId = new Map<string, PluginFactRecord>();
		for (const record of records) {
			if (sameScope(record.scope, action.scope)) byId.set(record.id, record);
		}
		return [...byId.values()];
	}

	setEnabled(id: string, enabled: boolean) {
		const plugin = this.plugins.get(id);
		if (!plugin) throw new PlannerError(404, "Task plugin not found");
		this.planner.transaction(() => {
			if (!this.db.setEnabled(id, enabled) || !enabled) return;
			for (const definition of plugin.subtypes) {
				for (const taskId of this.db.staleAutomatic(definition.id))
					this.db.enqueue(taskId, Date.now());
			}
		});
		return this.installations().find((installation) => installation.id === id)!;
	}

	enabledTypes() {
		const installations = this.db.installations();
		return Array.from(this.types.values()).flatMap(({ pluginId, definition }) => {
			const epoch = installations.get(pluginId);
			return epoch ? [{ definition, epoch }] : [];
		});
	}

	private getTask(id: string) {
		const task = this.planner.task(id);
		if (!task) throw new PlannerError(404, "Task not found");
		return task;
	}

	details(id: string): TaskDetails {
		const task = this.getTask(id);
		const enabled = new Map(this.enabledTypes().map(({ definition, epoch }) => [definition.id, epoch]));
		return {
			task,
			subtypes: this.db.subtypes(id, task.title).filter(({ typeId }) => enabled.has(typeId)),
			classification: this.db.classification(id),
			lastClassification: this.db.lastResult(id, task.title, enabled),
		};
	}

	attachAtCapture(id: string, typeId: string) {
		const definition = this.types.get(typeId)?.definition;
		if (!definition?.captureCommand) throw new PlannerError(404, "Task capture command unavailable");
		return this.write(id, typeId, { revision: null, data: definition.initialData });
	}

	write(id: string, typeId: string, input: WriteTaskSubtype) {
		return this.planner.transaction(() => {
			const task = this.getTask(id);
			const type = this.types.get(typeId);
			if (!type || !this.db.installations().has(type.pluginId)) {
				throw new PlannerError(404, "Enabled task subtype not found");
			}
			const current = this.db.subtypes(id, task.title).find((subtype) => subtype.typeId === typeId);
			if ((current?.revision ?? null) !== input.revision) {
				throw new PlannerError(409, "This task subtype changed. Reload its details and try again.");
			}
			return this.store(id, type.definition, "manual", input.data);
		});
	}

	store(
		id: string,
		definition: Definition,
		source: TaskSubtype["source"],
		data: TaskSubtype["data"],
		classifiedTitle: string | null = null,
	) {
		const subtype: TaskSubtype = {
			typeId: definition.id,
			schemaVersion: definition.schemaVersion,
			revision: crypto.randomUUID(),
			source,
			data: data === null ? null : definition.schema.parse(data),
		};
		this.db.putSubtype(id, subtype, classifiedTitle);
		return subtype;
	}
}
