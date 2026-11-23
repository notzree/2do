import { expect, it, vi } from "vite-plus/test";
import worker from "../src/index.ts";

it.each([
	["/api", "API"],
	["/api/health", "API"],
	["/apiary", "ASSETS"],
] as const)("routes %s to %s", async (path, target) => {
	const env = {
		API: { fetch: vi.fn(async () => new Response("API")) },
		ASSETS: { fetch: vi.fn(async () => new Response("ASSETS")) },
	};
	const request = new Request(new URL(path, "https://example.com"));
	const response = await worker.fetch(request, env);
	expect(await response.text()).toBe(target);
	expect(env[target].fetch).toHaveBeenCalledWith(request);
});
