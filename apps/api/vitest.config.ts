import { markdownImportPlugin } from "@flue/vite/internal";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Each pool member boots workerd with the full Google and Flue runtime.
  test: { maxWorkers: 3 },
  plugins: [
    markdownImportPlugin(),
    cloudflareTest({ wrangler: { configPath: "test/wrangler.json" } }),
  ],
});
