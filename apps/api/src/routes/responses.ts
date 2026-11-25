import { z } from "@hono/zod-openapi";

// Shared domain schemas can be loaded independently of Hono in Vite's Worker runtime.
export function named<S extends z.ZodType>(schema: S, name: string) {
	return schema.meta({ id: name });
}

function jsonContent<S extends z.ZodType>(schema: S) {
	return { "application/json": { schema } };
}
export function jsonBody<S extends z.ZodType>(schema: S) {
	return { required: true, content: jsonContent(schema) };
}
export function jsonResponse<S extends z.ZodType>(schema: S, description = "Success") {
	return { description, content: jsonContent(schema) };
}

const error = z.object({ error: z.string() }).openapi("Error");
export const accessErrors = {
	401: jsonResponse(error, "Cloudflare Access authentication required"),
	412: jsonResponse(error, "The supplied X-Planner-Scope belongs to another planner"),
	503: jsonResponse(error, "Authentication unavailable"),
};
export const invalidInput = jsonResponse(error, "Invalid input");
export const missing = jsonResponse(error, "Resource not found");
export const conflict = jsonResponse(error, "Revision, graph or ID conflict");
export const tooLarge = jsonResponse(error, "Body too large");
export const unsupported = jsonResponse(error, "Unsupported media type");
export const jsonErrors = { 400: invalidInput, 413: tooLarge, 415: unsupported };
