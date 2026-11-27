import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite-plus";

export default defineConfig(({ command, isPreview }) => {
	const agents = flue({ providers: ["cloudflare"] });
	const configureFlue = flueWorkerConfig();
	return {
		plugins: [
			agents,
			cloudflare({
				config(worker) {
					configureFlue(worker);
					// Cloudflare's v1 Vite plugin dynamically imports node:process,
					// which fails with workerd's 2026-11-17 module registry.
					if (command === "serve" && !isPreview) {
						worker.compatibility_flags = [
							...(worker.compatibility_flags ?? []),
							"legacy_module_registry",
						];
					}
				},
			}),
		],
		environments: {
			"2do_api": {
				optimizeDeps: {
					// Flue generates a virtual Worker entry. Scan its source modules and
					// include the packages imported directly by the generated wrapper.
					entries: ["src/app.ts", "src/cloudflare.ts", "src/agents/**/*.ts"],
					include: ["agents", "@flue/runtime/internal", "@flue/runtime/cloudflare/internal"],
					// Flue packages these imports when it transforms the agent source.
					rolldownOptions: { external: [/\/SKILL\.md$/] },
				},
			},
		},
		fmt: { useTabs: true },
	};
});
