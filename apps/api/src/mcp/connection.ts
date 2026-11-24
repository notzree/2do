import { defineMcpConnection } from "@flue/runtime";

export function plannerConnection(planners: Env["USER_PLANNER"], identity: string) {
	return defineMcpConnection({
		name: "planner",
		url: "https://planner.internal/mcp",
		// Flue caches the connection across submissions. Resolve the stub in the
		// active request context each time, using only the authenticated identity.
		fetch: (input, init) => planners.getByName(identity).fetch(new Request(input, init)),
	});
}
