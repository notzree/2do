import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [react(), cloudflare()],
	fmt: { useTabs: true },
	lint: {
		options: { typeAware: true, typeCheck: true },
	},
});
