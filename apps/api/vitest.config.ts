import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "test/wrangler.json" } })],
});
