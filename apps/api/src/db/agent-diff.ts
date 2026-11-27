// Only user-visible fields participate in a reviewed change. Internal leases, version tokens
// and command receipts can legitimately differ between a preview and its eventual commit.
import type { InboxChange } from "../interfaces/agent-inbox.ts";

type Surface = { table: string; key: string[]; value: string };
const surfaces: Surface[] = [
  { table: "task", key: ["id"], value: "json_remove(@.document,'$.revision')" },
  {
    table: "dependency",
    key: ["prerequisite", "dependent"],
    value: "json_object('requires',@.prerequisite,'dependent',@.dependent)",
  },
  { table: "reminder_rule", key: ["id"], value: "json(@.document)" },
  {
    table: "reminder_slot",
    key: ["ruleId", "slot"],
    value: "json_object('anchor',@.anchor,'scheduledFor',@.due)",
  },
  {
    table: "reminder_notice",
    key: ["ruleId", "id"],
    // Presenter shows the requested duration. The wall-clock snooze deadline is assigned on approval.
    value:
      "CASE WHEN @.snooze IS NULL THEN NULL ELSE json_object('action',@.action,'anchor',@.anchor,'title',@.title) END",
  },
  { table: "day_page", key: ["day"], value: "json(@.document)" },
  {
    table: "task_subtype",
    key: ["taskId", "typeId"],
    value: "json_object('data',json(@.document),'source',@.source)",
  },
  { table: "task_plugin_install", key: ["id"], value: "json_object('enabled',json('true'))" },
  {
    table: "task_prompt_skip",
    key: ["taskId", "promptId"],
    value: "json_object('skipped',json('true'))",
  },
  { table: "task_classification", key: ["taskId"], value: "json_object('requested',json('true'))" },
  { table: "plugin_workflow", key: ["taskId", "typeId"], value: "json(@.document)" },
  {
    table: "plugin_effect",
    key: ["taskId", "typeId", "effect"],
    value: "json_object('effect',@.effect,'input',json(@.input))",
  },
  {
    table: "plugin_metric_observation",
    key: ["taskId", "typeId", "sourceKey", "metricId"],
    value: "json_object('day',@.day,'value',@.value)",
  },
  { table: "plugin_report_calendar", key: ["id"], value: "json_object('timeZone',@.timeZone)" },
  { table: "plugin_goal", key: ["id"], value: "json_remove(@.document,'$.revision')" },
  { table: "planner_goal", key: ["id"], value: "json(@.document)" },
  { table: "goal_task_link", key: ["goalId", "taskId"], value: "json_object('role',@.role)" },
  { table: "goal_check_in", key: ["goalId", "id"], value: "json_object('note',@.note)" },
  { table: "task_capture", key: ["taskId"], value: "json(@.document)" },
  { table: "time_proposal", key: ["id"], value: "json_object('status',@.status)" },
  {
    table: "calendar_link",
    key: ["taskId"],
    value: "json_object('published',json('true'),'origin',@.origin)",
  },
];
export function installChangeCapture(storage: DurableObjectStorage) {
  if (storage.kv.get("agent:diff-schema") === 2) return;
  storage.transactionSync(() => {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS agent_diff_scope (enabled INTEGER PRIMARY KEY)");
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS agent_diff_log (entity TEXT, target TEXT, old_value TEXT, new_value TEXT)",
    );
    for (const surface of surfaces) {
      for (const event of ["INSERT", "UPDATE", "DELETE"]) {
        const ref = event === "DELETE" ? "OLD" : "NEW";
        const key = "json_array(" + surface.key.map((k) => ref + "." + k).join(",") + ")";
        const value = (ref: string) => surface.value.replaceAll("@", ref);
        const oldValue = event === "INSERT" ? "NULL" : value("OLD");
        const newValue = event === "DELETE" ? "NULL" : value("NEW");
        storage.sql
          .exec(`CREATE TRIGGER IF NOT EXISTS agent_diff_${surface.table}_${event} AFTER ${event}
					ON ${surface.table} WHEN EXISTS(SELECT 1 FROM agent_diff_scope)
					BEGIN INSERT INTO agent_diff_log VALUES ('${surface.table}',${key},${oldValue},${newValue}); END`);
      }
    }
    storage.kv.put("agent:diff-schema", 2);
  });
}

export function beginChangeCapture(storage: DurableObjectStorage) {
  storage.sql.exec("INSERT INTO agent_diff_scope VALUES(1)");
}
export function endChangeCapture(storage: DurableObjectStorage) {
  const rows = storage.sql.exec<{
    entity: string;
    target: string;
    old_value: string | null;
    new_value: string | null;
  }>("SELECT * FROM agent_diff_log ORDER BY rowid");
  const grouped = new Map<string, { before: unknown; after: unknown }>();
  for (const row of rows) {
    const label = row.entity + " " + (JSON.parse(row.target) as unknown[]).join(" / ");
    const existing = grouped.get(label);
    const after: unknown = row.new_value === null ? null : JSON.parse(row.new_value);
    if (existing) existing.after = after;
    else
      grouped.set(label, {
        before: row.old_value === null ? null : JSON.parse(row.old_value),
        after,
      });
  }
  storage.sql.exec("DELETE FROM agent_diff_scope");
  storage.sql.exec("DELETE FROM agent_diff_log");
  const changes: InboxChange[] = [];
  const taskTitles: Record<string, string> = {};
  for (const [field, { before, after }] of grouped) {
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (field.startsWith("task ")) {
      const task = (before ?? after) as { title: string };
      taskTitles[field.slice(5)] = task.title;
    }
    if (
      typeof before === "object" &&
      before &&
      typeof after === "object" &&
      after &&
      !Array.isArray(before) &&
      !Array.isArray(after)
    ) {
      const left = before as Record<string, unknown>,
        right = after as Record<string, unknown>;
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (JSON.stringify(left[key]) !== JSON.stringify(right[key]))
          changes.push({
            field: field + " · " + key,
            before: left[key] ?? null,
            after: right[key] ?? null,
          });
      }
    } else changes.push({ field, before, after });
  }
  return { changes: changes.sort((a, b) => a.field.localeCompare(b.field)), taskTitles };
}
