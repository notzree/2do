import { useEffect, useRef, useState } from "react";
import { plan, type Plan } from "@2do/api/plan";
async function request(path: string, init?: RequestInit) {
	const response = await fetch(path, { ...init, redirect: "error" });
	if (
		!response.ok ||
		(response.status !== 204 && !response.headers.get("Content-Type")?.includes("application/json"))
	) {
		const result = await response.json().catch(() => ({}));
		throw new Error(result.error ?? "Could not reach your planner. Reload to sign in again.");
	}
	return response;
}
async function loadPlan(signal?: AbortSignal) {
	return plan.parse(await (await request("/api/tasks", { signal })).json());
}

export type Mutate = (path: string, method: string, body?: object) => Promise<boolean>;
export function usePlan() {
	const lock = useRef(false);
	const [data, setData] = useState<Plan>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		const refresh = () => loadPlan(controller.signal)
			.then((result) => {
				if (!controller.signal.aborted) setData(result);
			})
			.catch(() => {
				if (!controller.signal.aborted)
					setError("Could not load your planner. Reload to try again.");
			});
		void refresh();
		window.addEventListener("notebook-tasks-created",refresh);
		return () => {controller.abort();window.removeEventListener("notebook-tasks-created",refresh);};
	}, []);
	async function mutate(path: string, method: string, body?: object) {
		if (lock.current) return false;
		lock.current = true;
		setBusy(true);
		setError("");
		try {
			await request(path, {
				method,
				...(body && {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not save the change.");
			lock.current = false;
			setBusy(false);
			return false;
		}
		try {
			setData(await loadPlan());
		} catch {
			setData(undefined);
			setError("Saved. Reload to see your updated plan.");
		} finally {
			lock.current = false;
			setBusy(false);
		}
		return true;
	}
	return { data, error, busy, mutate };
}
