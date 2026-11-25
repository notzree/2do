import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";

export function jsonLimits(maxSize = 16384, message = "Body too large") {
	return [
		bodyLimit({ maxSize, onError: (c) => c.json({ error: message }, 413) }),
		createMiddleware(async (c, next) => {
			if (!c.req.header("Content-Type")) return c.json({ error: "Expected application/json" }, 415);
			await next();
		}),
	];
}
