import { expect, it } from "vite-plus/test";
import { openApiDocument } from "../src/routes/contract.ts";
import { operationEffect } from "../src/core/agent-approval.ts";
import { connectorAgentToolNames } from "../src/connectors/inbox-actions.ts";
import tools from "../src/mcp/tools.json";

const surfaces: Record<string, string[]> = {
  "Tasks, graph and inspector": [
    "searchTasks",
    "listTasks",
    "getTask",
    "updateTask",
    "createTask",
    "deleteTask",
    "traverse",
    "addDependency",
    "removeDependency",
    "readTaskSummaries",
    "readTaskCapture",
    "readTaskDetails",
    "reorderSubtasks",
  ],
  "Notebook and carryover": [
    "readPage",
    "writePage",
    "carryOverTasks",
    "readCarryoverSettings",
    "setCarryoverSettings",
  ],
  "Plugin workflows and reports": [
    "classifyTask",
    "listTaskPlugins",
    "setTaskPluginEnabled",
    "writeTaskSubtype",
    "setTaskPromptSkipped",
    "runPluginAction",
    "listPluginMetrics",
    "readMetricSeries",
    "getReportSettings",
    "setReportSettings",
  ],
  "Goals and history": [
    "listGoals",
    "createGoal",
    "updateGoal",
    "readGoalHistory",
    "readAllGoalHistory",
    "listPlannerGoals",
    "createPlannerGoal",
    "editPlannerGoal",
    "readGoalProgress",
  ],
  "Agents workspace and chat": [
    "listChats",
    "searchConversationContext",
    "linkWorkspaceItem",
    "listReview",
    "listRecentDecisions",
    "proposeTime",
    "proposeChanges",
    "askUser",
    "notifyUser",
    "listAgentInbox",
    "readAgentInboxItem",
  ],
  Reminders: [
    "listReminders",
    "setReminder",
    "setReminderSettings",
    "deleteReminder",
    "snoozeReminder",
    "dismissReminder",
  ],
  "Connected accounts": [...connectorAgentToolNames],
};
const nonToolPaths: Record<string, string> = {
  getAgentInboxCounts: "notebook sidebar attention badge",
  readAgentInboxItems: "batched conversation card reads",
  listAgentActivity: "authenticated Agents activity timeline",
  updateChat: "manage side-chat title and archive status",
  branchChat: "user-confirmed continuation from a Main chat exchange",
  reportChatMilestone: "human report action backed by the same operation as the native Flue tool",
  recordDeviceReceipt: "originating browser acknowledgement",
  health: "service health",
  openapi: "API discovery",
  planRevision: "cache validation",
  markAgentInboxItem: "inbox card or originating browser command",
  decideAgentInboxItem: "authenticated decision in Inbox or chat",
  readApprovalPolicy: "Agent settings",
  updateApprovalPolicy: "human permission settings",
  decideTime: "authenticated inbox decision",
  undoTime: "guarded time undo in the browser",
  subscribeReminderPush: "device permission",
  unsubscribeReminderPush: "device subscription",
  uploadImage: "chat attachment picker",
  readImage: "owner-scoped image rendering",
  registerChat: "originating browser",
  authorizeConnection: "OAuth in the browser",
  completeConnection: "Google callback",
  recentWearableWorkouts: "private recent workout list in Connections",
  setMailSuggestions: "human content-access setting",
};

it("assigns each contracted product action to an agent tool or its user-facing entry point", () => {
  const catalog = tools.map((t) => t.name).sort();
  expect(Object.values(surfaces).flat().sort()).toEqual(catalog);
  const operations = Object.values(openApiDocument().paths ?? {})
    .flatMap((path) => Object.values(path ?? {}))
    .map((operation) => (operation as { operationId: string }).operationId)
    .sort();
  expect([...catalog, ...Object.keys(nonToolPaths)].sort()).toEqual(operations);
});
it("classifies every mutating planner tool before it reaches the command executor", () => {
  const interactions = new Set(["proposeChanges", "askUser", "notifyUser", "proposeTime", "linkWorkspaceItem"]);
  const queries = new Set(["searchTasks", "readTaskSummaries"]);
  for (const tool of tools) {
    if (
      tool.method.toUpperCase() === "GET" ||
      queries.has(tool.name) ||
      interactions.has(tool.name) ||
      connectorAgentToolNames.has(tool.name)
    )
      continue;
    expect(operationEffect(tool.name), tool.name).toBeTruthy();
  }
});

it("approves an existing sibling reorder without changing task dependencies", async () => {
  const { env } = await import("cloudflare:test");
  const planner = env.USER_PLANNER.getByName(crypto.randomUUID());
  const api = async (path: string, method = "GET", body?: object) => {
    const res = await planner.fetch("https://test/api/" + path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
    });
    expect(res.ok, method + " " + path).toBe(true);
    return res.json<Record<string, unknown>>();
  };
  const parent = crypto.randomUUID(),
    a = crypto.randomUUID(),
    b = crypto.randomUUID();
  await api("tasks", "POST", { id: parent, title: "Project" });
  for (const [id, title] of [
    [a, "Draft"],
    [b, "Proofread"],
  ])
    await api("tasks", "POST", { id, parentId: parent, title });
  const before = [a, b].sort(),
    after = [...before].reverse();
  const changes = await api("agent/changes", "POST", {
    id: crypto.randomUUID(),
    title: "Reorder project subtasks",
    reason: "Requested new sequence",
    steps: [{ operation: "reorderSubtasks", args: { id: parent, requestBody: { before, after } } }],
  });
  expect(changes.status).toBe("pending");
  expect((await api("tasks/" + a)).siblingOrder).toBeUndefined();
  await api("agent/inbox/" + changes.id + "/decision", "POST", {
    version: changes.version,
    decision: "approve",
  });
  expect((await api("tasks/" + after[0])).siblingOrder).toBe(0);
  expect((await api("tasks/" + after[1])).siblingOrder).toBe(1);
  expect((await api("tasks")).edges).toEqual([]);
});
