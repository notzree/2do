import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { Task } from "@2do/api/plan";
import { summaryBatchSize, taskSummaries } from "@2do/api/task-summaries";
import { dayKey, onDay } from "./calendar.ts";
import { api, pageQuery } from "./query.ts";

export const summariesKey = ["planner", "summaries"] as const;

function summaryQuery(ids: string[]) {
  return queryOptions({
    queryKey: [...summariesKey, ids],
    queryFn: async ({ signal }) =>
      taskSummaries.parse(
        (
          await api.POST("/api/tasks/summaries", {
            body: { ids },
            signal,
          })
        ).data,
      ),
    refetchInterval: (q) =>
      q.state.data?.some((s) => s.extracting || s.classification === "pending") ? 1500 : false,
  });
}

export function useWeekTaskHints(days: Date[], tasks: Task[], includeUnscheduled: boolean) {
  // Observers share the day editors' query cache, including references to tasks scheduled elsewhere.
  const pages = useQueries({ queries: days.map((d) => pageQuery(dayKey(d))) });
  const references = new Set(
    pages.flatMap(
      ({ data }) =>
        data?.doc.content.flatMap((n) => (n.type === "taskRef" ? [n.attrs.id] : [])) ?? [],
    ),
  );
  const ids = tasks
    .filter(
      (t) =>
        references.has(t.id) ||
        (includeUnscheduled && !t.schedule) ||
        days.some((d) => onDay(t, d)),
    )
    .map((t) => t.id)
    .sort();
  // Each day may add references to tasks scheduled elsewhere. Batch the settled set once.
  const loadingPages = pages.some((page) => page.isPending);
  const queries = useQueries({ queries: loadingPages ? [] : summaryBatches(ids) });
  const summaries = new Map(
    queries.flatMap(({ data }) => (data ?? []).map((s) => [s.id, s] as const)),
  );
  const pending = [...summaries.values()].filter((s) => s.classification === "pending").length;
  const failed = queries.filter((q) => q.isError);
  const rejected = [...summaries.values()].some((s) => s.classification === "failed");
  const status = failed.length
    ? "Hints unavailable"
    : pending
      ? `Classifying ${pending} ${pending === 1 ? "task" : "tasks"}`
      : rejected
        ? "Classification failed"
        : loadingPages || queries.some((q) => q.isPending)
          ? "Checking hints"
          : "Ready";
  return { summaries, status, failed };
}

function summaryBatches(ids: string[]) {
  const batches = [];
  for (let i = 0; i < ids.length; i += summaryBatchSize)
    batches.push(summaryQuery(ids.slice(i, i + summaryBatchSize)));
  return batches;
}

export function useInspectorPrompts(taskId: string) {
  return useQuery(summaryQuery([taskId])).data?.[0]?.prompts ?? [];
}
