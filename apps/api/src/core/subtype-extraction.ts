import type { ExtractionJob, ExtractionQueue } from "../db/subtype-extraction.ts";
import type { ExtractionField, TitleExtractor } from "../extractors/clairic.ts";
import type { CommitTaskWrite, PlannerDatabase } from "../interfaces/database.ts";
import { fieldGroupData, fieldName, readFieldValue } from "../interfaces/subtype-field-values.ts";
import type { Task } from "../interfaces/plan.ts";
import type { TaskSubtype, TaskSubtypeDefinition } from "../interfaces/task-plugins.ts";
import type { PluginData } from "../interfaces/plugin-workflows.ts";
import type { TaskPlugins } from "./task-plugins.ts";

type Definition = TaskSubtypeDefinition<PluginData, unknown>;
const leaseMs = 60_000;
const maxBatchSize = 4;

function missingFields(definition: Definition, data: PluginData) {
  return (definition.editor ?? []).flatMap((group) =>
    group.fields.flatMap((field) => {
      const path = fieldName(group, field);
      const instructions = definition.extraction?.[path];
      return instructions && readFieldValue(data, path) === undefined
        ? [{ path, kind: field.kind, instructions }]
        : [];
    }),
  );
}

export class SubtypeExtraction {
  constructor(
    readonly queue: ExtractionQueue,
    private readonly planner: Pick<PlannerDatabase, "task">,
    private readonly plugins: TaskPlugins,
    private readonly extract: TitleExtractor,
  ) {}

  enqueue(task: Task, definition: Definition, subtype: TaskSubtype, text: string) {
    if (!subtype.data || !missingFields(definition, subtype.data).length) return;
    const epoch = this.plugins.db.installations().get(definition.id.split(".")[0]);
    if (!epoch || this.plugins.workflows.db.job(task.id, definition.id)) return;
    const workflowRevision = this.plugins.workflows.db.state(task.id, definition.id)?.revision;
    this.queue.enqueue({
      taskId: task.id,
      typeId: definition.id,
      title: task.title,
      revision: subtype.revision,
      epoch,
      input: { text, workflowRevision },
      due: Date.now(),
      attempts: 0,
    });
  }

  private current(job: ExtractionJob) {
    const task = this.planner.task(job.taskId);
    if (!task || task.title !== job.title) return;
    const type = this.plugins.enabledTypes().find(({ definition }) => definition.id === job.typeId);
    if (!type || type.epoch !== job.epoch) return;
    const subtype = this.plugins.db
      .subtypes(task.id, task.title)
      .find((s) => s.typeId === job.typeId);
    if (
      !subtype?.data ||
      subtype.revision !== job.revision ||
      subtype.schemaVersion !== type.definition.schemaVersion
    )
      return;
    if (
      this.plugins.workflows.db.state(task.id, job.typeId)?.revision !== job.input.workflowRevision
    )
      return;
    return { definition: type.definition, subtype, data: subtype.data };
  }

  async processDue(commit: CommitTaskWrite) {
    const work = await commit(() =>
      this.queue.claimDue(Date.now(), leaseMs, maxBatchSize).flatMap((job) => {
        const current = this.current(job);
        if (!current || job.attempts > 3) {
          this.queue.finish(job);
          return [];
        }
        return [{ job, fields: missingFields(current.definition, current.data) }];
      }),
    );
    // Keep each extraction in its own model context and wait for every claim to settle.
    const results = await Promise.allSettled(
      work.map(({ job, fields }) => this.processJob(commit, job, fields)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async processJob(commit: CommitTaskWrite, job: ExtractionJob, fields: ExtractionField[]) {
    try {
      const values = fields.length
        ? await this.extract(job.input.text, fields, AbortSignal.timeout(leaseMs))
        : {};
      await commit(() => {
        if (!this.queue.finish(job)) return;
        const current = this.current(job);
        if (!current) return;
        const data = { ...current.data };
        let changed = false;
        for (const { path } of fields) {
          if (!Object.hasOwn(values, path)) continue;
          const [key, nested] = path.split(".");
          if (nested) data[key] = { ...fieldGroupData(data, key), [nested]: values[path] };
          else data[key] = values[path];
          changed = true;
        }
        if (changed)
          this.plugins.store(
            job.taskId,
            current.definition,
            current.subtype.source,
            data,
            current.subtype.source === "automatic" ? job.title : null,
          );
      });
    } catch {
      await commit(() => {
        if (job.attempts < 3) this.queue.retry(job);
        else {
          this.queue.finish(job);
          console.warn(JSON.stringify({ event: "subtype_extraction_failed", typeId: job.typeId }));
        }
      });
    }
  }
}
