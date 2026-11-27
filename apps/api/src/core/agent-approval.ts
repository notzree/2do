import type { ApprovalPolicy, InboxChange, InboxEffect } from "../interfaces/agent-inbox.ts";

const effects: Record<string, InboxEffect> = {
  reorderSubtasks: "local-edit",
  createTask: "local-create",
  updateTask: "local-edit",
  deleteTask: "local-delete",
  addDependency: "local-edit",
  removeDependency: "local-edit",
  writePage: "local-edit",
  createPlannerGoal: "local-create",
  editPlannerGoal: "local-edit",
  createGoal: "local-create",
  updateGoal: "local-edit",
  runPluginAction: "workflow",
  writeTaskSubtype: "local-edit",
  setTaskPromptSkipped: "local-edit",
  carryOverTasks: "local-edit",
  setTaskPluginEnabled: "settings",
  setCarryoverSettings: "settings",
  setReportSettings: "settings",
  setReminderSettings: "settings",
  classifyTask: "workflow",
  setReminder: "local-edit",
  deleteReminder: "local-delete",
  snoozeReminder: "local-edit",
  dismissReminder: "local-edit",
};
export function operationEffect(operation: string) {
  return effects[operation];
}
export function resolvedEffects(
  primary: InboxEffect,
  changes: InboxChange[],
  linked: (id: string) => boolean,
) {
  const result = new Set<InboxEffect>([primary]);
  for (const change of changes) {
    const [entity, id] = change.field.split(" ");
    if (entity === "task" || entity === "planner_goal" || entity === "day_page" || entity === "reminder_rule" || entity === "reminder_slot" || entity === "reminder_notice") {
      if (!change.field.includes(" · "))
        result.add(
          change.before === null
            ? "local-create"
            : change.after === null
              ? "local-delete"
              : "local-edit",
        );
      if (
        entity === "task" &&
        linked(id) &&
        (!change.field.includes(" · ") || / · (title|schedule|kind)$/.test(change.field))
      )
        result.add("external");
    }
    if (entity === "calendar_link") result.add("external");
    if (
      entity === "plugin_effect" ||
      entity === "plugin_workflow" ||
      entity === "plugin_metric_observation"
    )
      result.add("workflow");
  }
  return Array.from(result).sort();
}
export type ApprovalScope = {
  operations: string[];
  resourceIds: string[];
  reversible: boolean;
  account?: string;
};
export function actionScope(operations: string[], changes: InboxChange[]): ApprovalScope {
  const ids = new Set<string>();
  for (const { field } of changes) {
    const [entity] = field.split(" · ");
    const split = entity.indexOf(" ");
    for (const id of (split < 0 ? entity : entity.slice(split + 1)).split(" / ")) ids.add(id);
  }
  // A reversible rule only covers simple field edits for which the previous
  // value can be restored through the same planner operation.
  const reversible =
    changes.length > 0 &&
    changes.every(
      ({ field }) =>
        /^task [^ ]+ · (title|completed|due|schedule|currentDay|durationMinutes|parentId)$/.test(
          field,
        ) || /^day_page [^ ]+ · content$/.test(field),
    );
  return { operations, resourceIds: [...ids], reversible };
}
export function autoApproved(
  policy: ApprovalPolicy,
  required: InboxEffect[],
  origin: "chat" | "scheduled" | undefined,
  scope: ApprovalScope,
) {
  if (!origin || !required.length || (origin==="scheduled" && required.includes("external"))) return false;
  for (const effect of required) {
    let allowed = false;
    for (const rule of policy.rules) {
      if (
        rule.effect !== effect ||
        rule.origin !== origin ||
        (rule.account && rule.account !== scope.account) ||
        (rule.reversibleOnly && !scope.reversible) ||
        (rule.maxResources && scope.resourceIds.length > rule.maxResources)
      )
        continue;
      const matches = (values: string[], limit?: string[]) =>
        !limit ||
        (values.length > 0 &&
          (rule.mode === "ask"
            ? values.some((v) => limit.includes(v))
            : values.every((v) => limit.includes(v))));
      if (
        !matches(scope.operations, rule.operations) ||
        !matches(scope.resourceIds, rule.resourceIds)
      )
        continue;
      if (rule.mode === "ask") return false;
      allowed = true;
    }
    if (!allowed) return false;
  }
  return true;
}
