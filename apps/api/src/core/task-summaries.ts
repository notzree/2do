import {
  eligibleTaskPrompts,
  fieldName,
  readEditorValue,
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
    for (const field of group.fields) {
      if (!field.inlayLabel) continue;
      const value = readEditorValue(subtype.data, group, field);
      if (value === undefined || (Array.isArray(value) && !value.length)) continue;
      const text =
        !Array.isArray(value)
          ? String(value)
          : value.slice(0, 2).join(", ") + (value.length > 2 ? ` +${value.length - 2}` : "");
      inlays.push({
        typeId: subtype.typeId,
        field: fieldName(group, field),
        label: field.inlayLabel,
        value: text,
      });
    }
  }
  return inlays;
}

export class TaskSummaries {
  constructor(private readonly plugins: TaskPlugins) {}

  read(ids: string[]): TaskSummary[] {
    const installations = this.plugins.installations().filter((p) => p.enabled);
    const definitions = new Map(
      installations.flatMap((p) => p.subtypes.map((t) => [t.id, t] as const)),
    );
    const extracting = this.plugins.db.extracting(ids);
    const rows = this.plugins.db.summaryRows(ids, new Set(definitions.keys()));
    return rows.map(({ task, classification, subtypes, skipped }) => {
      const active = subtypes.map(({ subtype }) => subtype);
      return {
        id: task.id,
        ...(extracting.has(task.id) && { extracting: true }),
        classification,
        types: subtypes.map(({ subtype, state }) => ({
          typeId: subtype.typeId,
          source: subtype.source,
          label: definitions.get(subtype.typeId)!.label,
          icon: definitions.get(subtype.typeId)!.icon,
          status: this.plugins.workflows.summaryStatus(subtype, state),
        })),
        inlays: active.flatMap((s) => fieldInlays(s, definitions.get(s.typeId)!)),
        prompts: eligibleTaskPrompts({ task, subtypes: active }, installations).map((prompt) => ({
          ...prompt,
          skipped: skipped?.has(prompt.id) ?? false,
        })),
      };
    });
  }

  setSkipped(taskId: string, promptId: string, skipped: boolean) {
    this.plugins.db.transaction(() => {
      const [summary] = this.read([taskId]);
      if (!summary || !summary.prompts.some((p) => p.id === promptId))
        throw new PlannerError(404, "Task prompt is unavailable");
      this.plugins.db.setPromptSkipped(taskId, promptId, skipped);
    });
  }
}
