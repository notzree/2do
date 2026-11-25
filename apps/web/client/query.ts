import createClient from "openapi-fetch";
import type { paths } from "./openapi.d.ts";
import { QueryClient, queryOptions } from "@tanstack/react-query";
import { dayPage, plannerScopeHeader, type DayPage } from "@2do/api/notebook";

export const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
});
export const planKey = ["planner", "tasks"] as const;
export const refreshPlanner = () => queryClient.invalidateQueries({ queryKey: ["planner"] });

export function pageQuery(date: string) {
	return queryOptions({
		queryKey: ["planner", "day", date],
		queryFn: async ({ signal }): Promise<DayPage & { plannerScope?: string }> => {
			const { data, response } = await api.GET("/api/days/{date}", { params: { path: { date } }, signal });
			return { ...dayPage.parse(data), plannerScope: response.headers.get(plannerScopeHeader) ?? undefined };
		},
	});
}

export class PlannerRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export const api = createClient<paths>({
	redirect: "error",
	headers: { Accept: "application/json" },
});
let verifiedScope: string | undefined;
let switchingPlanner = false;
export const isSwitchingPlanner = () => switchingPlanner;
api.use({
	onRequest({ request }) {
		if (verifiedScope && request.method !== "GET" && !request.headers.has(plannerScopeHeader))
			request.headers.set(plannerScopeHeader, verifiedScope);
	},
	async onResponse({ response, request }) {
		const scope = response.headers.get(plannerScopeHeader);
		if ((scope && verifiedScope && scope !== verifiedScope) ||
			(response.status === 412 && request.headers.has(plannerScopeHeader))) {
			if (!switchingPlanner && typeof window !== "undefined") {
				switchingPlanner = true;
				window.location.reload();
			}
			throw new PlannerRequestError(412, "The active planner changed. Reopen this account to recover its drafts.");
		}
		if (scope) verifiedScope = scope;
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			throw new PlannerRequestError(
				response.status,
				typeof body?.error === "string"
					? body.error
					: "Could not reach your planner. Reload to sign in again.",
			);
		}
		if (
			request.headers.get("Accept") === "application/json" &&
			response.status !== 204 &&
			!response.headers.get("Content-Type")?.includes("application/json")
		)
			throw new Error("Could not reach your planner. Reload to sign in again.");
	},
});
