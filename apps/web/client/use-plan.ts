import { taskObservationsHeader } from "@2do/api/plugin-reports";
import { refreshPlannerChange, type PlannerChange } from "./planner-cache.ts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { plan } from "@2do/api/plan";
import type { components } from "./openapi.d.ts";
import { api, planKey } from "./query.ts";
import { deleteNotebookTask } from "./day-buffer.ts";

export type Mutate = ReturnType<typeof usePlan>["mutate"];

type Write = { change: PlannerChange; execute: () => Promise<{ response: Response } | void> };

export const planQuery = queryOptions({
	queryKey: planKey,
	queryFn: async ({ signal }) => plan.parse((await api.GET("/api/tasks", { signal })).data),
});

export function usePlan(enabled = true) {
	const client = useQueryClient();
	const pendingDeletes = useRef(new Map<string, Promise<boolean>>());
	const query = useQuery({ ...planQuery, enabled });
	useQuery({
		queryKey: ["planner", "revision"],
		enabled: enabled && !!query.data,
		refetchInterval: 60_000,
		queryFn: async ({ signal }) => {
			const { data } = await api.GET("/api/plan/revision", { signal });
			const cached = client.getQueryData<typeof query.data>(planKey);
			if (data && cached && data.revision > cached.revision) {
        await Promise.all([
          client.invalidateQueries({ queryKey: planKey }),
          client.invalidateQueries({ queryKey: ["planner", "reports"] }),
        ]);
      }
			return data?.revision ?? 0;
		},
	});
	const mutation = useMutation({
		scope: { id: "planner-writes" },
		mutationFn: ({ execute }: Write) => execute(),
		onSettled: (result, error, { change }) => {
			const measured = change.kind === "delete" ||
				(change.kind === "update" && result?.response.headers.get(taskObservationsHeader) !== "0");
			return Promise.all([
				refreshPlannerChange(client, change, measured),
				// An interrupted DELETE can lose its page receipt.
				change.kind === "delete" && error && client.invalidateQueries({ queryKey: ["planner", "day"] }),
			]);
		},
	});
	async function run(change: PlannerChange, execute: Write["execute"]) {
		try {
			await mutation.mutateAsync({ change, execute });
			return true;
		} catch {
			return false;
		}
	}
	const edgeRevision = query.data && { expectedRevision: String(query.data.revision) };
	return {
		data: query.data,
		error: (mutation.error ?? query.error)?.message ?? "",
		busy: mutation.isPending,
		mutate: {
			createTask: (body: components["schemas"]["CreateTask"]) =>
				run({ kind: "create", id: body.id }, () => api.POST("/api/tasks", { body })),
			updateTask: (id: string, body: components["schemas"]["PatchTask"]) =>
				run({ kind: "update", id }, () => api.PATCH("/api/tasks/{id}", { params: { path: { id } }, body })),
			deleteTask: (id: string) => {
				const pending = pendingDeletes.current.get(id);
				if (pending) return pending;
				const expectedRevision = query.data?.tasks.find((task) => task.id === id)?.revision;
				const result = run({ kind: "delete", id }, () => deleteNotebookTask(id, expectedRevision)).finally(() => pendingDeletes.current.delete(id));
				pendingDeletes.current.set(id, result);
				return result;
			},
			addDependency: (from: string, to: string) =>
				run({ kind: "dependency" }, () => api.PUT("/api/dependencies/{from}/{to}", { params: { path: { from, to }, query: edgeRevision } })),
			removeDependency: (from: string, to: string) =>
				run({ kind: "dependency" }, () => api.DELETE("/api/dependencies/{from}/{to}", { params: { path: { from, to }, query: edgeRevision } })),
		},
	};
}
