import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite-plus";

// flue() must come before cloudflare(): it scans the 'use agent' modules,
// generates the Worker entry and Durable Object bindings, and hands them to
// the Cloudflare plugin through flueWorkerConfig().
export default defineConfig({
	plugins: [flue({ providers: ["cloudflare"] }), cloudflare({ config: flueWorkerConfig() })],
	fmt: { useTabs: true },
});
