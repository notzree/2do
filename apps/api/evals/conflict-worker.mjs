// Staged next to the production bundle only for the local Copilot evaluations.
import { UserPlanner as ProductionPlanner } from "./index.js";
export { default, FlueCopilotAgent } from "./index.js";

export class UserPlanner extends ProductionPlanner {
	async fetch(request) {
		if (request.method === "POST" && new URL(request.url).pathname === "/mcp") {
			const call = await request.clone().json();
			if (call.method === "tools/call" && call.params.name === "updateTask") {
				await this.#moveFixtureBeforeEdit(call.params.arguments.id);
			}
		}
		return super.fetch(request);
	}

	async #moveFixtureBeforeEdit(id) {
		const url = "https://planner.internal/api/tasks/" + encodeURIComponent(id);
		const found = await super.fetch(new Request(url));
		if (!found.ok) return;
		const task = await found.json();
		if (task.title !== "Draft repair estimate" || task.schedule) return;
		// A second editor moves the fixture after Copilot reads it and before its first PATCH.
		const moved = await super.fetch(
			new Request(url, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					revision: task.revision,
					schedule: { type: "day", date: "2026-12-03" },
				}),
			}),
		);
		if (!moved.ok) throw new Error("Could not stage the concurrent planner edit");
	}
}
