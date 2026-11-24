import { DurableObject } from "cloudflare:workers";
import { Planner } from "./core/planner.ts";
import { SqlitePlannerDatabase } from "./db/planner.ts";
import { plannerMcpHandler } from "./mcp/server.ts";
import { notebookRoutes } from "./routes/notebook.ts";
import { plannerRoutes } from "./routes/tasks.ts";

export class UserPlanner extends DurableObject<Env> {
	private readonly planner = new Planner(new SqlitePlannerDatabase(this.ctx.storage));
	private readonly routes = plannerRoutes(this.planner);
	private readonly notebook = notebookRoutes(this.ctx, this.env.NOTEBOOK_IMAGES, this.planner);

	private readonly mcp = plannerMcpHandler((request) => this.api(request));

	fetch(request: Request) {
		if (new URL(request.url).pathname === "/mcp") return this.mcp.fetch(request);
		return this.api(request);
	}

	private async api(request: Request) {
		const path = new URL(request.url).pathname;
		return (
			path.startsWith("/api/days/") || path === "/api/images" || path.startsWith("/api/images/")
				? this.notebook
				: this.routes
		).fetch(request);
	}
}
