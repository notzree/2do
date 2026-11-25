import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { PlannerStore } from "../db/planner.ts";
import { jobs, subtypes, taskPromptSkips, tasks } from "../db/schema.ts";
import {
  eligibleTaskPrompts,
  type TaskPluginInstallation,
  type TaskSubtype,
} from "../interfaces/task-plugins.ts";
import type { TaskSummary } from "../interfaces/task-summaries.ts";
import { PlannerError } from "./planner.ts";
import type { TaskPlugins } from "./task-plugins.ts";

function fieldInlays(subtype: TaskSubtype, definition: TaskPluginInstallation["subtypes"][number]) {
  const inlays: TaskSummary["inlays"] = [];
  if (!subtype.data || subtype.schemaVersion !== definition.schemaVersion) return inlays;
  for (const group of definition.editor ?? []) {
    const data = group.key ? subtype.data[group.key] : subtype.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    for (const field of group.fields) {
      if (!field.inlayLabel) continue;
      const value = (data as Record<string, unknown>)[field.key];
      let text: string;
      if (field.kind === "number" && typeof value === "number") text = String(value);
      else if (
        field.kind === "text-list" &&
        Array.isArray(value) &&
        value.length &&
        value.every((v) => typeof v === "string")
      ) {
        text = value.slice(0, 2).join(", ") + (value.length > 2 ? ` +${value.length - 2}` : "");
      } else continue;
      inlays.push({
        typeId: subtype.typeId,
        field: group.key ? group.key + "." + field.key : field.key,
        label: field.inlayLabel,
        value: text,
      });
    }
  }
  return inlays;
}

export class TaskSummaries {
  constructor(
    private readonly store: PlannerStore,
    private readonly plugins: TaskPlugins,
  ) {}

  read(ids: string[]): TaskSummary[] {
    const installations = this.plugins.installations().filter((p) => p.enabled);
    const definitions = new Map(
      installations.flatMap((p) => p.subtypes.map((t) => [t.id, t] as const)),
    );
    const rows = this.store
      .select({ task: tasks.document, job: jobs.taskId, due: jobs.due })
      .from(tasks)
      .leftJoin(jobs, eq(tasks.id, jobs.taskId))
      .where(inArray(tasks.id, ids))
      .all();
    const matches = new Map<string, TaskSubtype[]>();
    if (definitions.size) {
      const found = this.store
        .select({ subtype: subtypes })
        .from(subtypes)
        .innerJoin(tasks, eq(subtypes.taskId, tasks.id))
        .where(
          and(
            inArray(subtypes.taskId, ids),
            or(
              eq(subtypes.source, "manual"),
              sql`${subtypes.classifiedTitle} = json_extract(${tasks.document}, '$.title')`,
            ),
          ),
        )
        .orderBy(subtypes.typeId)
        .all();
      for (const { subtype } of found) {
        if (!definitions.has(subtype.typeId) || subtype.document === null) continue;
        const list = matches.get(subtype.taskId) ?? [];
        list.push({
          typeId: subtype.typeId,
          revision: subtype.revision,
          schemaVersion: subtype.schemaVersion,
          source: subtype.source,
          data: subtype.document,
        });
        matches.set(subtype.taskId, list);
      }
    }
    const skipped = new Map<string, Set<string>>();
    if (matches.size) {
      for (const { taskId, promptId } of this.store
        .select()
        .from(taskPromptSkips)
        .where(inArray(taskPromptSkips.taskId, [...matches.keys()]))
        .all()) {
        const set = skipped.get(taskId) ?? new Set<string>();
        set.add(promptId);
        skipped.set(taskId, set);
      }
    }
    return rows.map(({ task, job, due }) => {
      const active = matches.get(task.id) ?? [];
      return {
        id: task.id,
        classification: !job ? "idle" : due === null ? "failed" : "pending",
        types: active.map(({ typeId, source }) => ({
          typeId,
          source,
          label: definitions.get(typeId)!.label,
          icon: definitions.get(typeId)!.icon,
        })),
        inlays: active.flatMap((s) => fieldInlays(s, definitions.get(s.typeId)!)),
        prompts: eligibleTaskPrompts({ task, subtypes: active }, installations).map((prompt) => ({
          ...prompt,
          skipped: skipped.get(task.id)?.has(prompt.id) ?? false,
        })),
      };
    });
  }

  setSkipped(taskId: string, promptId: string, skipped: boolean) {
    this.store.transaction(() => {
      const [summary] = this.read([taskId]);
      if (!summary || !summary.prompts.some((p) => p.id === promptId))
        throw new PlannerError(404, "Task prompt is unavailable");
      if (skipped)
        this.store.insert(taskPromptSkips).values({ taskId, promptId }).onConflictDoNothing().run();
      else
        this.store
          .delete(taskPromptSkips)
          .where(and(eq(taskPromptSkips.taskId, taskId), eq(taskPromptSkips.promptId, promptId)))
          .run();
    });
  }
}
