import { queryOptions, useQuery } from "@tanstack/react-query";
import {
	goal,
	goalHistory,
	metricDefinition,
	metricSeries,
	reportSettings,
	type GoalTarget,
} from "@2do/api/plugin-reports";
import { api, queryClient } from "./query.ts";
import type { WeekStart } from "./calendar.ts";

export const reportKey = ["planner", "reports"] as const;
export const settingsKey = ["planner", "report-settings"] as const;

export function useReportSettings() {
	return useQuery({
		queryKey: settingsKey,
		queryFn: async ({ signal }) => {
			const saved = reportSettings.parse((await api.GET("/api/report-settings", { signal })).data);
			if (saved.timeZone) return saved;
			const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
			const initial = await api.PUT("/api/report-settings", {
				body: { timeZone, onlyIfUnset: true },
				signal,
			});
			await queryClient.invalidateQueries({ queryKey: ["planner", "details"] });
			return reportSettings.parse(initial.data);
		},
		staleTime: 60_000,
	});
}

export async function saveReportingZone(timeZone: string) {
	return reportSettings.parse((await api.PUT("/api/report-settings", { body: { timeZone } })).data);
}

export const metricsQuery = queryOptions({
	queryKey: [...reportKey, "metrics"],
	queryFn: async ({ signal }) =>
		metricDefinition.array().parse((await api.GET("/api/plugin-metrics", { signal })).data),
});

export const goalsQuery = queryOptions({
	queryKey: [...reportKey, "goals"],
	queryFn: async ({ signal }) => goal.array().parse((await api.GET("/api/goals", { signal })).data),
});

export function historyQuery(from: string, to: string) {
	return queryOptions({
		queryKey: [...reportKey, "history", from, to],
		queryFn: async ({ signal }) =>
			goalHistory
				.array()
				.parse(
					(await api.GET("/api/goals/history", { params: { query: { from, to } }, signal })).data,
				),
	});
}

export type Bucket = "day" | "week" | "month";

export function seriesQuery(
	metricId: string,
	from: string,
	to: string,
	bucket: Bucket,
	weekStart: WeekStart,
) {
	return queryOptions({
		queryKey: [...reportKey, "series", metricId, from, to, bucket, weekStart],
		queryFn: async ({ signal }) =>
			metricSeries.parse(
				(
					await api.GET("/api/plugin-metrics/{metricId}/series", {
						params: {
							path: { metricId },
							query: { from, to, bucket, weekStart: weekStart ? "1" : "0" },
						},
						signal,
					})
				).data,
			),
	});
}

export async function createDailyGoal(body: {
	id: string;
	metricId: string;
	label: string;
	effectiveFrom: string;
	target: GoalTarget;
}) {
	return goal.parse((await api.POST("/api/goals", { body })).data);
}

export async function changeDailyGoal(
	id: string,
	body: { revision: string; effectiveFrom: string; target: GoalTarget | null },
) {
	return goal.parse((await api.PUT("/api/goals/{id}", { params: { path: { id } }, body })).data);
}
