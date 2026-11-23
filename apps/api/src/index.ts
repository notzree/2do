import { DurableObject } from "cloudflare:workers";

// The authenticated command handler will select one instance per internal user ID.
export class UserPlanner extends DurableObject {}

export default {
	fetch(request) {
		if (new URL(request.url).pathname !== "/api/health") {
			return Response.json({ error: "Not found" }, { status: 404 });
		}
		if (request.method !== "GET") {
			return Response.json(
				{ error: "Method not allowed" },
				{ status: 405, headers: { Allow: "GET" } },
			);
		}
		return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
	},
} satisfies ExportedHandler;
