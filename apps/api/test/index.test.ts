import { SELF } from "cloudflare:test";
import { expect, it } from "vite-plus/test";

it("serves the API health check", async () => {
	const response = await SELF.fetch("https://example.com/api/health");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ status: "ok" });
});

it("returns a JSON 404 for unknown routes", async () => {
	const response = await SELF.fetch("https://example.com/api/missing");
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: "Not found" });
});

it("rejects writes to the health endpoint", async () => {
	const response = await SELF.fetch("https://example.com/api/health", { method: "POST" });
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("GET");
});
