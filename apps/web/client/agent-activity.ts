import { useMemo } from "react";
import { infiniteQueryOptions, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { activityPage } from "@2do/api/agents-workspace";
import { api } from "./query.ts";
export function activityOptions(chat?: string) {
  return infiniteQueryOptions({
    queryKey: ["planner", "activity", chat ?? "all"],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      activityPage.parse(
        (
          await api.GET("/api/agents/activity", {
            params: { query: { chat, cursor: pageParam } },
            signal,
          })
        ).data,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
}

export function useConversationActivity(chat: string, event: string | undefined, enabled: boolean) {
  const activity = useInfiniteQuery({ ...activityOptions(chat), enabled });
  const target = useQuery({
    queryKey: ["planner", "activity", "event", chat, event],
    enabled: enabled && !!event,
    queryFn: async ({ signal }) => activityPage.parse((await api.GET("/api/agents/activity", {
      params: { query: { chat, event } }, signal,
    })).data).items[0] ?? null,
  });
  return useMemo(() => {
    const events = new Map(activity.data?.pages.flatMap(page => page.items.map(e => [e.id, e] as const)));
    if (target.data) events.set(target.data.id, target.data);
    return [...events.values()].sort((a, b) => b.at.localeCompare(a.at));
  }, [activity.data, target.data]);
}
