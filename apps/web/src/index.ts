type RoutingBindings = {
	API: Pick<Env["API"], "fetch">;
	API_DEV_URL: string;
	ASSETS: Pick<Env["ASSETS"], "fetch">;
};

export default {
	fetch(request: Request, env: RoutingBindings) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api" || pathname.startsWith("/api/")) {
			// In development the API runs as its own Vite dev server, so the
			// service binding is bypassed in favor of a direct forward.
			if (env.API_DEV_URL) {
				const url = new URL(request.url);
				const dev = new URL(env.API_DEV_URL);
				url.protocol = dev.protocol;
				url.host = dev.host;
				return fetch(new Request(url, request));
			}
			return env.API.fetch(request);
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
