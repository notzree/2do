import { useQuery } from "@tanstack/react-query";
import { api, queryClient } from "./query.ts";
import {
  pluginInstallation,
  pluginInstallations,
  taskDetails,
  taskSubtype,
  type TaskPluginInstallation,
  type WriteTaskSubtype,
} from "@2do/api/task-plugins";

export async function readTaskDetails(taskId: string, signal: AbortSignal) {
  return taskDetails.parse(
    (await api.GET("/api/tasks/{id}/details", { params: { path: { id: taskId } }, signal })).data,
  );
}

export async function saveTaskSubtype(taskId: string, typeId: string, input: WriteTaskSubtype) {
  const saved = taskSubtype.parse(
    (
      await api.PUT("/api/tasks/{id}/subtypes/{typeId}", {
        params: { path: { id: taskId, typeId } },
        body: input,
      })
    ).data,
  );
  void queryClient.invalidateQueries({ queryKey: ["planner", "summaries"] });
  void queryClient.invalidateQueries({ queryKey: ["planner", "reports"] });
  return saved;
}

export async function setTaskPluginEnabled(id: string, enabled: boolean) {
  return pluginInstallation.parse(
    (
      await api.PUT("/api/task-plugins/{pluginId}", {
        params: { path: { pluginId: id } },
        body: { enabled },
      })
    ).data,
  );
}

export function useTaskPlugins() {
  const queryKey = ["planner", "plugins"];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      pluginInstallations.parse((await api.GET("/api/task-plugins", { signal })).data),
  });
  return {
    plugins: query.data,
    error: query.error?.message,
    retry: () => void query.refetch(),
    update: (updated: TaskPluginInstallation) => {
      queryClient.setQueryData<TaskPluginInstallation[]>(queryKey, (current) =>
        current?.map((plugin) => (plugin.id === updated.id ? updated : plugin)),
      );
      void queryClient.invalidateQueries({ queryKey: ["planner", "details"] });
      void queryClient.invalidateQueries({ queryKey: ["planner", "summaries"] });
      void queryClient.invalidateQueries({ queryKey: ["planner", "reports"] });
    },
  };
}
