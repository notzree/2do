import { reportingDay } from "../interfaces/plugin-reports.ts";
import type { TaskSubtype, TaskSubtypeDefinition } from "../interfaces/task-plugins.ts";
import {
  actionInputSchema,
  type PluginData,
  type WorkflowCommand,
  type WorkflowDetails,
  type WorkflowEvent,
  type WorkflowSnapshot,
  type EffectHandler,
} from "../interfaces/plugin-workflows.ts";
import type { Task } from "../interfaces/plan.ts";
import type { CommitTaskWrite, PlannerDatabase } from "../interfaces/database.ts";
import { WorkflowDatabase, type EffectJob } from "../db/plugin-workflows.ts";
import { SqlitePluginReportDatabase } from "../db/plugin-reports.ts";
import type { SqliteTaskPluginDatabase } from "../db/task-plugins.ts";
import { PlannerError } from "./planner.ts";

type Definition = TaskSubtypeDefinition<PluginData, unknown>;
type Registered = { pluginId: string; definition: Definition };
const maxAttempts = 3;
const leaseMs = 60_000;

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
function upgraded(
  data: PluginData,
  from: number,
  to: number,
  steps: Definition["migrations"],
  titles: readonly string[] = [],
) {
  for (let version = from; version < to; version++) {
    if (!steps?.[version]) throw new Error("Missing plugin migration from version " + version);
    data = steps[version](data, titles);
  }
  return data;
}

export class PluginWorkflows {
  readonly db: WorkflowDatabase;
  readonly reports: SqlitePluginReportDatabase;
  private readonly effectIds: ReadonlySet<string>;
  constructor(
    private readonly planner: Pick<PlannerDatabase, "task" | "transaction">,
    private readonly subtypes: SqliteTaskPluginDatabase,
    private readonly types: ReadonlyMap<string, Registered>,
    private readonly handlers: ReadonlyMap<string, EffectHandler>,
    private readonly metricVersions: ReadonlyMap<string, number>,
  ) {
    this.db = subtypes.workflows;
    this.reports = subtypes.reports;
    this.effectIds = new Set(handlers.keys());
  }

  private snapshot(
    task: Task,
    subtype: TaskSubtype | undefined,
    definition: Definition,
  ): WorkflowSnapshot | undefined {
    if (!subtype?.data || subtype.schemaVersion !== definition.schemaVersion) return;
    const timeZone = this.reports.timeZone();
    return {
      task,
      data: definition.schema.parse(subtype.data),
      revision: subtype.revision,
      timeZone,
      today: reportingDay(timeZone),
    };
  }
  private clear(taskId: string, typeId: string) {
    this.db.forget(taskId, typeId);
    this.reports.replaceObservations(taskId, typeId, "", []);
  }
  summaryStatus(subtype: TaskSubtype, state: { version: number; document: PluginData } | null) {
    const definition = this.types.get(subtype.typeId)?.definition;
    const flow = definition?.workflow;
    if (!flow?.summaryStatus || definition?.schemaVersion !== subtype.schemaVersion ||
        (state && state.version !== flow.version)) return;
    return flow.summaryStatus(flow.schema.parse(state?.document ?? flow.initial));
  }
  describe(
    task: Task,
    subtype: TaskSubtype,
    installationEpoch: string,
  ): WorkflowDetails | undefined {
    const definition = this.types.get(subtype.typeId)?.definition;
    if (!definition?.workflow) return;
    const current = this.snapshot(task, subtype, definition);
    if (!current) return;
    const row = this.db.state(task.id, definition.id);
    const flow = definition.workflow;
    if (row && row.version !== flow.version) return;
    const pending = !!this.db.job(task.id, definition.id);
    const view = flow.describe(
      current,
      flow.schema.parse(row?.document ?? flow.initial),
      pending,
      this.effectIds,
    );
    return {
      typeId: definition.id,
      installationEpoch,
      taskRevision: task.revision,
      subtypeRevision: subtype.revision,
      workflowRevision: row?.revision ?? null,
      pending,
      status: view.status,
      properties: view.properties,
      actions: view.actions.map((action) => {
        const command = flow.commands.find((c) => c.id === action.id);
        if (!command) throw new Error("Undeclared workflow action " + action.id);
        return {
          ...command,
          label: action.label ?? command.label,
          defaults: action.defaults ?? {},
        };
      }),
    };
  }

  private transition(
    type: Registered,
    previous: WorkflowSnapshot | undefined,
    current: WorkflowSnapshot,
    event: WorkflowEvent,
    epoch: string,
  ) {
    const { definition } = type;
    const flow = definition.workflow!;
    const id = current.task.id;
    const row = this.db.state(id, definition.id);
    if (row && row.version !== flow.version)
      throw new PlannerError(409, "This workflow needs a compatible version.");
    const state = flow.schema.parse(row?.document ?? flow.initial);
    const next = flow.transition(previous, current, state, event);
    const document = flow.schema.parse(next.state);
    if (event.kind === "command" && next.confirmSubtype) {
      const confirmed = this.subtypes.confirmAutomatic(id, definition.id, current.revision);
      if (confirmed) current = { ...current, revision: confirmed.revision };
    }
    const dataChanged = previous?.revision !== current.revision;
    const pendingInputChanged =
      previous?.task.revision !== current.task.revision && !!this.db.job(id, definition.id);
    if (
      row &&
      event.kind === "changed" &&
      !next.effect &&
      !dataChanged &&
      !pendingInputChanged &&
      canonical(document) === canonical(state)
    ) {
      // A plugin can measure task fields even when its private state stays constant.
      this.project(type, current, document, row.revision);
      return row.revision;
    }
    const revision = crypto.randomUUID();
    this.db.cancel(id, definition.id);
    this.db.putState({
      taskId: id,
      typeId: definition.id,
      version: flow.version,
      revision,
      document,
      suspendedChanges: null,
    });
    this.project(type, current, document, revision);
    if (next.effect) {
      if (!next.effect.id.startsWith(type.pluginId + ".") || !this.handlers.has(next.effect.id))
        throw new PlannerError(409, "This plugin effect is unavailable.");
      this.db.enqueue({
        taskId: id,
        typeId: definition.id,
        effect: next.effect.id,
        input: next.effect.input,
        token: crypto.randomUUID(),
        epoch,
        subtypeRevision: current.revision,
        workflowRevision: revision,
        due: Date.now(),
        attempts: 0,
      });
    }
    return revision;
  }
  private project(
    type: Registered,
    current: WorkflowSnapshot,
    state: PluginData,
    revision: string,
  ) {
    const observations = type.definition.workflow!.measure(current, state);
    for (const o of observations) {
      if (
        !o.metricId.startsWith(type.pluginId + ".") ||
        this.metricVersions.get(o.metricId) !== o.metricVersion
      )
        throw new Error("Undeclared plugin metric " + o.metricId);
    }
    this.reports.replaceObservations(current.task.id, type.definition.id, revision, observations);
  }
  changed(
    typeId: string,
    task: Task,
    subtype?: TaskSubtype,
    previousTask?: Task,
    previousSubtype?: TaskSubtype,
  ) {
    const type = this.types.get(typeId);
    if (!type?.definition.workflow) return;
    const current = this.snapshot(task, subtype, type.definition);
    if (!current) {
      // Preserve opaque future data until a compatible binary is available.
      if (!subtype?.data) this.clear(task.id, typeId);
      return;
    }
    const row = this.db.state(task.id, typeId);
    if (row && row.version !== type.definition.workflow.version) return;
    const epoch = this.subtypes.installations().get(type.pluginId);
    if (!epoch) {
      if (row && previousTask) {
        const keys = (Object.keys(task) as (keyof Task)[]).filter(
          (key) => key !== "revision" && canonical(previousTask[key]) !== canonical(task[key]),
        );
        if (keys.length)
          this.db.putState({
            ...row,
            suspendedChanges: [...new Set([...(row.suspendedChanges ?? []), ...keys])],
          });
      }
      return;
    }
    const previous = previousTask && this.snapshot(previousTask, previousSubtype, type.definition);
    this.transition(type, previous, current, { kind: "changed" }, epoch);
  }
  taskChanged(task: Task, previous?: Task) {
    // Creation precedes attachment in the notebook transaction. An untyped task has no workflow.
    if (!previous) return;
    const after = this.subtypes.subtypes(task.id, task.title);
    const before =
      previous.title === task.title ? after : this.subtypes.subtypes(task.id, previous.title);
    for (const typeId of new Set([...before, ...after].map((s) => s.typeId))) {
      this.changed(
        typeId,
        task,
        after.find((s) => s.typeId === typeId),
        previous,
        before.find((s) => s.typeId === typeId),
      );
    }
  }
  installation(typeIds: string[], epoch?: string) {
    if (!epoch) {
      this.db.cancelTypes(typeIds);
      return;
    }
    for (const id of typeIds) {
      const type = this.types.get(id)!;
      if (!type.definition.workflow) continue;
      // Existing attachments can predate the introduction of a workflow on this subtype.
      for (const { task, subtype } of this.subtypes.attachmentsWithoutWorkflow(
        id,
        type.definition.schemaVersion,
      )) {
        this.changed(id, task, subtype);
      }
      for (const row of this.db.suspended(id)) {
        const task = this.planner.task(row.taskId);
        const subtype =
          task && this.subtypes.subtypes(task.id, task.title).find((s) => s.typeId === id);
        const current = task && this.snapshot(task, subtype, type.definition);
        if (current && type.definition.workflow?.version === row.version)
          this.transition(
            type,
            undefined,
            current,
            { kind: "resumed", changedTaskFields: row.suspendedChanges ?? [] },
            epoch,
          );
      }
    }
  }
  async command(
    taskId: string,
    typeId: string,
    actionId: string,
    command: WorkflowCommand,
    commit: CommitTaskWrite,
  ) {
    const bytes = new TextEncoder().encode(canonical({ taskId, typeId, actionId, command }));
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return commit(() =>
      this.planner.transaction(() => {
        const type = this.types.get(typeId);
        const epoch = type && this.subtypes.installations().get(type.pluginId);
        const task = this.planner.task(taskId);
        if (!task || !epoch || !type?.definition.workflow)
          throw new PlannerError(404, "Plugin action unavailable");
        const signature = epoch + "." + digest;
        const receipt = this.db.receipt(command.commandId);
        if (receipt) {
          if (receipt.signature !== signature)
            throw new PlannerError(409, "This command ID was already used for another request.");
          return { commandId: command.commandId, workflowRevision: receipt.workflowRevision };
        }
        const subtype = this.subtypes.subtypes(taskId, task.title).find((s) => s.typeId === typeId);
        const view = subtype && this.describe(task, subtype, epoch);
        if (
          !view ||
          view.installationEpoch !== command.installationEpoch ||
          view.taskRevision !== command.taskRevision ||
          view.subtypeRevision !== command.subtypeRevision ||
          view.workflowRevision !== command.workflowRevision
        )
          throw new PlannerError(409, "This workflow changed. Reload before submitting.");
        const action = view.actions.find((a) => a.id === actionId);
        if (!action)
          throw new PlannerError(409, "This action is unavailable in the current state.");
        const input = actionInputSchema(action).parse(command.input);
        for (const field of action.fields) {
          const value = input[field.key];
          if (field.kind === "image" && typeof value === "string" && !this.db.ownsImage(value))
            throw new PlannerError(404, "Image unavailable");
        }
        const current = this.snapshot(task, subtype, type.definition)!;
        const workflowRevision = this.transition(
          type,
          current,
          current,
          { kind: "command", id: actionId, input },
          epoch,
        );
        this.db.saveReceipt({ commandId: command.commandId, taskId, signature, workflowRevision });
        return { commandId: command.commandId, workflowRevision };
      }),
    );
  }

  migrate() {
    this.planner.transaction(() => {
      for (const type of this.types.values()) {
        const d = type.definition;
        const oldSubtypes = d.schemaVersion > 1 ? this.db.olderSubtypes(d.id, d.schemaVersion) : [];
        for (const row of oldSubtypes) {
          const data =
            row.document === null
              ? null
              : d.schema.parse(
                  upgraded(
                    row.document,
                    row.schemaVersion,
                    d.schemaVersion,
                    d.migrations,
                    [
                      this.subtypes.originalCapture(row.taskId),
                      row.classifiedTitle,
                      this.planner.task(row.taskId)?.title,
                    ].filter((title): title is string => !!title),
                  ),
                );
          this.subtypes.putSubtype(
            row.taskId,
            {
              typeId: d.id,
              revision: crypto.randomUUID(),
              source: row.source,
              schemaVersion: d.schemaVersion,
              data,
            },
            row.classifiedTitle,
          );
          this.db.cancel(row.taskId, d.id);
          const state = this.db.state(row.taskId, d.id);
          if (state)
            this.db.putState({
              ...state,
              suspendedChanges: [...(state.suspendedChanges ?? []), "schemaVersion"],
            });
        }
        if (!d.workflow) continue;
        const oldStates =
          d.workflow.version > 1 ? this.db.olderStates(d.id, d.workflow.version) : [];
        for (const row of oldStates) {
          const document = d.workflow.schema.parse(
            upgraded(row.document, row.version, d.workflow.version, d.workflow.migrations),
          );
          this.db.cancel(row.taskId, d.id);
          this.db.putState({
            ...row,
            revision: crypto.randomUUID(),
            version: d.workflow.version,
            document,
            suspendedChanges: row.suspendedChanges ?? [],
          });
        }
        const epoch = this.subtypes.installations().get(type.pluginId);
        if (epoch) this.installation([d.id], epoch);
      }
    });
  }

  async processDue(commit: CommitTaskWrite, now = Date.now()) {
    const jobs = await commit(() => this.db.claim(now, now + leaseMs));
    await Promise.all(
      jobs.map(async (job) => {
        let result: unknown,
          failed = true;
        if (job.attempts <= maxAttempts) {
          try {
            const handler = this.handlers.get(job.effect);
            if (handler) {
              result = await handler(job.input, AbortSignal.timeout(leaseMs));
              failed = false;
            }
          } catch {
            /* Persist retry or surface a failure through the plugin. */
          }
        }
        await commit(() => this.settle(job, result, failed));
      }),
    );
  }
  private settle(job: EffectJob, result: unknown, failed: boolean) {
    const currentJob = this.db.job(job.taskId, job.typeId);
    if (currentJob?.token !== job.token || currentJob.attempts !== job.attempts) return;
    const type = this.types.get(job.typeId);
    const epoch = type && this.subtypes.installations().get(type.pluginId);
    const task = this.planner.task(job.taskId);
    const subtype =
      task && this.subtypes.subtypes(task.id, task.title).find((s) => s.typeId === job.typeId);
    const state = this.db.state(job.taskId, job.typeId);
    if (
      !type?.definition.workflow ||
      !task ||
      epoch !== job.epoch ||
      subtype?.revision !== job.subtypeRevision ||
      state?.revision !== job.workflowRevision ||
      state.version !== type.definition.workflow.version
    ) {
      this.db.cancel(job.taskId, job.typeId);
      return;
    }
    if (failed && job.attempts < maxAttempts) {
      this.db.retry(job, Date.now() + 2_000 * job.attempts);
      return;
    }
    const current = this.snapshot(task, subtype, type.definition);
    if (current)
      this.transition(
        type,
        current,
        current,
        { kind: "effect", id: job.effect, result, failed },
        epoch,
      );
    else this.db.cancel(job.taskId, job.typeId);
  }
}
