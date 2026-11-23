type RoutingBindings = {
	API: Pick<Env["API"], "fetch">;
	ASSETS: Pick<Env["ASSETS"], "fetch">;
};

export default {
	fetch(request: Request, env: RoutingBindings) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api" || pathname.startsWith("/api/")) {
			return env.API.fetch(request);
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
