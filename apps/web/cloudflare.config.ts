import { env } from "node:process";
import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig(({ mode }) => ({
	worker: {
		name: "2do-web",
		compatibilityDate: "2026-11-17",
		observability: { enabled: true, traces: { enabled: true } },
		entrypoint,
		workersDev: false,
		previewUrls: false,
		domains: env.PLANNER_HOSTNAME ? [env.PLANNER_HOSTNAME] : [],
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api", "/api/*"],
		},
		env: {
			API: bindings.worker({ worker: "2do-api" }),
			// Development only: forward /api straight to the API dev server,
			// which now runs as its own Vite (Flue) process instead of cf dev.
			API_DEV_URL: bindings.text(mode === "development" ? "http://localhost:5174" : ""),
			ASSETS: bindings.assets(),
		},
	},
}));
