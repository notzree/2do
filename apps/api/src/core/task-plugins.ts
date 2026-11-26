import { goalType, type GoalSubtypeDefinition } from "../interfaces/goals.ts";
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
import { PluginWorkflows } from "./plugin-workflows.ts";
import { validateSubtypeDefinition, describeSubtype } from "../interfaces/plugin-fields.ts";
import {
	actionDefinition,
	actionInputSchema,
	type EffectHandler,
} from "../interfaces/plugin-workflows.ts";
import { metricDefinition } from "../interfaces/plugin-reports.ts";
import { pluginInstallation, type TaskPluginInstallation } from "../interfaces/task-plugins.ts";

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
	readonly workflows: PluginWorkflows;
	private readonly goalDefinitions = new Map<string, GoalSubtypeDefinition>();

	enabledGoalType(id: string) {
		return this.db.installations().has(id.split(".")[0]) ? this.goalDefinitions.get(id) : undefined;
	}
	private readonly types = new Map<string, { pluginId: string; definition: Definition }>();
	private readonly plugins = new Map<string, TaskPlugin>();
	private readonly features = new Map<string, { consumer: string; feature: PluginFeature }>();
	private readonly manifests: TaskPluginInstallation[] = [];

	constructor(
		private readonly planner: Pick<PlannerDatabase, "task" | "transaction">,
		readonly db: SqliteTaskPluginDatabase,
		plugins: readonly TaskPlugin[],
		private readonly factAccess?: PluginFactAccess,
		effects: ReadonlyMap<string, EffectHandler> = new Map(),
		readonly extractTitle?: (task: Task, definition: Definition, subtype: TaskSubtype, text: string) => void,
	) {
		const metrics = new Map<string, number>();
		this.workflows = new PluginWorkflows(planner, db, this.types, effects, metrics);
		for (const plugin of plugins) {
			pluginId.parse(plugin.id);
			if (this.plugins.has(plugin.id)) throw new Error("Duplicate task plugin " + plugin.id);
			this.plugins.set(plugin.id, plugin);
			for (const metric of plugin.metrics ?? []) {
				metricDefinition.parse(metric);
				if (!metric.id.startsWith(plugin.id + ".") || metrics.has(metric.id))
					throw new Error("Invalid or duplicate metric " + metric.id);
				metrics.set(metric.id, metric.version);
			}
			for (const definition of plugin.goalSubtypes ?? []) {
				if (!definition.id.startsWith(plugin.id + ".") || this.goalDefinitions.has(definition.id) ||
					definition.metrics.some(id => !plugin.metrics?.some(m => m.id === id)))
					throw new Error("Invalid goal subtype " + definition.id);
				this.goalDefinitions.set(definition.id, definition);
			}
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
				validateSubtypeDefinition(definition);
				if (definition.workflow) {
					const flow = definition.workflow;
					if (!Number.isSafeInteger(flow.version) || flow.version < 1)
						throw new Error("Invalid workflow version");
					flow.schema.parse(flow.initial);
					const ids = new Set<string>();
					for (const command of flow.commands) {
						actionInputSchema(actionDefinition.parse(command));
						if (ids.has(command.id)) throw new Error("Duplicate workflow command " + command.id);
						ids.add(command.id);
					}
				}
				subtypeId.parse(definition.id);
				if (definition.captureCommand !== undefined) pluginId.parse(definition.captureCommand);
				if (!definition.id.startsWith(plugin.id + ".") || this.types.has(definition.id)) {
					throw new Error("Invalid or duplicate task subtype " + definition.id);
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
			this.manifests.push(
				pluginInstallation.parse({
					id: plugin.id,
					label: plugin.label,
					description: plugin.description,
					metrics: plugin.metrics,
					goalSubtypes: plugin.goalSubtypes?.map(({ id, label, version, fields }) => goalType.parse({ id, label, version, fields })),
					facts: plugin.facts,
					enabled: false,
					features: plugin.features?.map(({ requires, ...feature }) => ({
						...feature,
						requires: { id: requires.id, version: requires.version },
					})),
					subtypes: plugin.subtypes.map(describeSubtype),
				}),
			);
		}
	}

	installations(): TaskPluginInstallation[] {
		const enabled = this.db.installations();
		return this.manifests.map((plugin) => ({ ...plugin, enabled: enabled.has(plugin.id) }));
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
			if (!this.db.setEnabled(id, enabled)) return;
			this.workflows.installation(
				plugin.subtypes.map((d) => d.id),
				this.db.installations().get(id),
			);
			if (!enabled) return;
			const enabledTypeIds = this.enabledTypes().map(({ definition }) => definition.id);
			for (const definition of plugin.subtypes) {
				const peers = enabledTypeIds.filter((typeId) => typeId !== definition.id);
				for (const taskId of this.db.automaticToRecheck(definition.id, peers))
					this.db.requestClassification(taskId, Date.now());
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

	incompatibleTypes(taskId: string) {
		return new Set(
			this.db
				.storedTypes(taskId)
				.filter(
					(row) =>
						row.version !== this.types.get(row.typeId)?.definition.schemaVersion,
				)
				.map((row) => row.typeId),
		);
	}

	private getTask(id: string) {
		const task = this.planner.task(id);
		if (!task) throw new PlannerError(404, "Task not found");
		return task;
	}

	details(id: string): TaskDetails {
		const task = this.getTask(id);
		const enabled = new Map(
			this.enabledTypes().map(({ definition, epoch }) => [definition.id, epoch]),
		);
		const subtypes = this.db.subtypes(id, task.title).filter(({ typeId }) => enabled.has(typeId));
		const workflows = subtypes.flatMap(
			(s) => this.workflows.describe(task, s, enabled.get(s.typeId)!) ?? [],
		);
		return {
			task,
			subtypes,
			...(workflows.length ? { workflows } : {}),
			classification: this.db.classification(id),
			...(this.db.extracting([id]).has(id) && { extracting: true }),
			lastClassification: this.db.lastResult(id, task.title, enabled),
		};
	}

	captureTiming(typeId?: string) {
		return typeId ? this.types.get(typeId)?.definition.captureTiming : undefined;
	}

	attachAtCapture(id: string, typeId: string, rawInput?: string, alias?:string) {
		const definition = this.types.get(typeId)?.definition;
		if (!definition?.captureCommand)
			throw new PlannerError(404, "Task capture command unavailable");
		const task = this.getTask(id);
		if (alias && !Object.hasOwn(definition.captureAliases ?? {},alias)) throw new PlannerError(409,"Capture shortcut unavailable.");
		const data = { ...definition.initialData, ...definition.fromTitle?.(rawInput ?? task.title), ...(alias && definition.captureAliases?.[alias]) };
		const record = this.write(id, typeId, { revision: null, data });
		this.extractTitle?.(task, definition, record, rawInput ?? task.title);
		return record;
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
		return this.planner.transaction(() => {
			const stored = this.db.storedTypes(id).find((row) => row.typeId === definition.id);
			if (stored && stored.version !== definition.schemaVersion)
				throw new PlannerError(409, "This subtype needs a compatible version before editing.");
			const task = this.getTask(id);
			const previous = this.db.subtypes(id, task.title).find((s) => s.typeId === definition.id);
			this.db.putSubtype(id, subtype, classifiedTitle);
			this.workflows.changed(definition.id, task, subtype, task, previous);
			return subtype;
		});
	}

	removeAutomatic(task: Task, typeId: string) {
		const previous = this.db.subtypes(task.id, task.title).find((s) => s.typeId === typeId);
		this.db.removeAutomatic(task.id, typeId);
		if (previous?.source === "automatic")
			this.workflows.changed(typeId, task, undefined, task, previous);
	}
}
