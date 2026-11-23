import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "2do-web",
		compatibilityDate: "2026-11-17",
		entrypoint,
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api", "/api/*"],
		},
		env: {
			API: bindings.worker({ worker: "2do-api" }),
			ASSETS: bindings.assets(),
		},
	},
});
