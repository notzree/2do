import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const name = "2do-api";

export default defineConfig({
	worker: {
		name,
		compatibilityDate: "2026-11-17",
		entrypoint,
		workersDev: false,
		previewUrls: false,
		exports: { UserPlanner: exports.durableObject({ storage: "sqlite" }) },
		env: {
			USER_PLANNER: bindings.durableObject({ worker: name, exportName: "UserPlanner" }),
		},
	},
});
