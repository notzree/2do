import type { QueryClient } from "@tanstack/react-query";
import type { Plan } from "@2do/api/plan";
import { planKey } from "./query.ts";

export const reviewKey = ["planner", "review"] as const;

export type PlannerChange =
  | { kind: "dependency" }
  | { kind: "create"; id?: string }
  | { kind: "update" | "delete" | "reviewSchedule"; id: string };

// Review responses include task titles, and recent decisions include a revision-based
// undo flag. A delete also reparents children and advances their task revisions.
export function refreshPlannerChange(client: QueryClient, change: PlannerChange, measured: boolean) {
  if (change.kind === "dependency") return client.invalidateQueries({ queryKey: planKey });

  const ids = new Set<string>();
  if (change.id) ids.add(change.id);
  if (change.kind === "delete") {
    for (const task of client.getQueryData<Plan>(planKey)?.tasks ?? []) {
      if (task.parentId === change.id) ids.add(task.id);
    }
  }
  return client.invalidateQueries({
    queryKey: ["planner"],
    predicate: ({ queryKey: [, resource, key], state }) => {
      switch (resource) {
        case "tasks": return true;
        case "details": return typeof key === "string" && ids.has(key);
        case "summaries": return Array.isArray(key) && key.some((id) => ids.has(id));
        case "capture": return key === change.id && (change.kind === "create" || change.kind === "delete");
        case "reports": return measured && (key === "series" || key === "history");
        case "review":
          if (change.kind === "reviewSchedule" || change.kind === "delete") return true;
          if (change.kind !== "update") return false;
          return !Array.isArray(state.data) || state.fetchStatus === "fetching" ||
            state.data.some((proposal: { taskId: string }) => ids.has(proposal.taskId));
        default: return false;
      }
    },
  });
}
