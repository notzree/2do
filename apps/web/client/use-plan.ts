import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { plan } from "@2do/api/plan";
import type { components } from "./openapi.d.ts";
import { api, planKey, queryClient } from "./query.ts";
import { deleteNotebookTask } from "./day-buffer.ts";

export type Mutate = ReturnType<typeof usePlan>["mutate"];

export function usePlan() {
	const pendingDeletes = useRef(new Map<string, Promise<boolean>>());
	const query = useQuery({
		queryKey: planKey,
		queryFn: async ({ signal }) => plan.parse((await api.GET("/api/tasks", { signal })).data),
	});
	const mutation = useMutation({
		scope: { id: "planner-writes" },
		mutationFn: (write: () => Promise<unknown>) => write(),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ["planner"] }),
	});
	async function run(write: () => Promise<unknown>) {
		try {
			await mutation.mutateAsync(write);
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
				run(() => api.POST("/api/tasks", { body })),
			updateTask: (id: string, body: components["schemas"]["PatchTask"]) =>
				run(() => api.PATCH("/api/tasks/{id}", { params: { path: { id } }, body })),
			deleteTask: (id: string) => {
				const pending = pendingDeletes.current.get(id);
				if (pending) return pending;
				const expectedRevision = query.data?.tasks.find((task) => task.id === id)?.revision;
				const result = run(() => deleteNotebookTask(id, expectedRevision)).finally(() => pendingDeletes.current.delete(id));
				pendingDeletes.current.set(id, result);
				return result;
			},
			addDependency: (from: string, to: string) =>
				run(() => api.PUT("/api/dependencies/{from}/{to}", { params: { path: { from, to }, query: edgeRevision } })),
			removeDependency: (from: string, to: string) =>
				run(() => api.DELETE("/api/dependencies/{from}/{to}", { params: { path: { from, to }, query: edgeRevision } })),
		},
	};
}
