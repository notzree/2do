import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vite-plus/test";
import { refreshPlannerChange, type PlannerChange } from "./planner-cache.ts";

const entries = {
  tasks: [["planner", "tasks"], { tasks: [{ id: "child", parentId: "task" }] }],
  details: [["planner", "details", "task"], {}],
  child: [["planner", "details", "child"], {}],
  other: [["planner", "details", "other"], {}],
  summaries: [["planner", "summaries", ["other", "task"]], []],
  unrelatedBatch: [["planner", "summaries", ["other"]], []],
  capture: [["planner", "capture", "task"], null],
  review: [["planner", "review"], []],
  recent: [["planner", "review", "recent"], [{ taskId: "task" }]],
  page: [["planner", "day", "2026-11-25"], {}],
  plugins: [["planner", "plugins"], []],
  settings: [["planner", "report-settings"], {}],
  metrics: [["planner", "reports", "metrics"], []],
  series: [["planner", "reports", "series", "protein"], {}],
  history: [["planner", "reports", "history", "2026-11-25"], []],
} as const;

async function invalidated(change: PlannerChange, measured = false) {
  const client = new QueryClient();
  for (const [key, data] of Object.values(entries)) client.setQueryData(key, data);
  await refreshPlannerChange(client, change, measured);
  return Object.entries(entries)
    .filter(([, [key]]) => client.getQueryState(key)?.isInvalidated)
    .map(([name]) => name);
}

it("refreshes task details, its summary batches and matching proposals on a rename", async () => {
  expect(await invalidated({ kind: "update", id: "task" })).toEqual([
    "tasks", "details", "summaries", "recent",
  ]);
});

it("refreshes report totals for measured tasks without reloading metric definitions or settings", async () => {
  expect(await invalidated({ kind: "update", id: "task" }, true)).toEqual([
    "tasks", "details", "summaries", "recent", "series", "history",
  ]);
});

it("refreshes reparented children on deletion and only the plan for dependency edits", async () => {
  expect(await invalidated({ kind: "delete", id: "task" }, true)).toEqual([
    "tasks", "details", "child", "summaries", "capture", "review", "recent", "series", "history",
  ]);
  expect(await invalidated({ kind: "dependency" })).toEqual(["tasks"]);
});

it("refreshes both review lists when a decision changes a task's schedule", async () => {
  expect(await invalidated({ kind: "reviewSchedule", id: "task" }, true)).toEqual([
    "tasks", "details", "summaries", "review", "recent", "series", "history",
  ]);
});
