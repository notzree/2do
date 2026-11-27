// Staged next to the production bundle only for the local Copilot evaluations.
import { UserPlanner as ProductionPlanner } from "./index.js";
export { default } from "./index.js";
export * from "./index.js";

export class UserPlanner extends ProductionPlanner {
	async finishReminderBrief(id, order) {
		const ok=await super.finishReminderBrief(id,order);
		this.ctx.storage.kv.put("eval:brief-result",{ok,order});
		return ok;
	}

	async fetch(request) {
		const url=new URL(request.url);
		if(request.method==="GET" && url.pathname==="/api/reminders" && url.searchParams.has("evalBriefResult"))
			return Response.json({result:this.ctx.storage.kv.get("eval:brief-result")??null});
		if(request.method==="PUT" && url.pathname.startsWith("/api/reminders/") &&
			["Synthetic scheduled briefing","Synthetic policy routine"].includes((await request.clone().json()).title)) {
			const response=await super.fetch(request);
			if(response.ok) {
				// Trigger the just-created daily rule immediately so this test can run at any hour.
				const now=Date.now();
				this.ctx.storage.sql.exec("UPDATE reminder_slot SET due=?,anchor=? WHERE ruleId=?",now,now,url.pathname.split("/").at(-1));
				await this.ctx.storage.setAlarm(now);
			}
			return response;
		}
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
