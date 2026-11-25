import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	accessErrors,
	invalidInput,
	jsonResponse,
	named,
	missing,
	tooLarge,
	unsupported,
} from "./responses.ts";
import { bodyLimit } from "hono/body-limit";
import { imageId, imageReceipt } from "../interfaces/notebook.ts";
import type { PlannerStore } from "../db/planner.ts";
import { images } from "../db/schema.ts";

const binary = { schema: { type: "string", format: "binary" } } as const;
const imageContent = {
	"image/png": binary,
	"image/jpeg": binary,
	"image/gif": binary,
	"image/webp": binary,
};

export const imageOperations = {
	uploadImage: createRoute({
		operationId: "uploadImage",
		method: "post",
		path: "/api/images",
		summary: "Upload a private PNG, JPEG, GIF or WebP, up to 8 MiB",
		middleware: bodyLimit({
			maxSize: 8 * 1024 * 1024,
			onError: (c) => c.json({ error: "Images must be 8 MiB or smaller" }, 413),
		}),
		request: { body: { required: true, content: imageContent } },
		responses: {
			201: jsonResponse(named(imageReceipt, "ImageReceipt")),
			...accessErrors,
			413: tooLarge,
			415: unsupported,
		},
	}),
	readImage: createRoute({
		operationId: "readImage",
		method: "get",
		path: "/api/images/{id}",
		summary: "Read an image belonging to the current planner",
		request: { params: z.object({ id: imageId }) },
		responses: {
			200: { description: "Private image", content: imageContent },
			...accessErrors,
			400: invalidInput,
			404: missing,
		},
	}),
};

function imageType(bytes: Uint8Array) {
	const prefix = String.fromCharCode(...bytes.slice(0, 12));
	if (prefix.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
	if (prefix.startsWith("\xff\xd8\xff")) return "image/jpeg";
	if (prefix.startsWith("GIF89a") || prefix.startsWith("GIF87a")) return "image/gif";
	if (prefix.startsWith("RIFF") && prefix.slice(8) === "WEBP") return "image/webp";
}
export function imageRoutes(owner: string, db: PlannerStore, bucket: R2Bucket) {
	const app = new OpenAPIHono();
	const key = (id: string) => owner + "/" + id;
	app.openapi(imageOperations.uploadImage, async (c) => {
		const bytes = new Uint8Array(await c.req.arrayBuffer());
		const type = imageType(bytes);
		if (!type || type !== c.req.header("Content-Type"))
			return c.json({ error: "Choose a PNG, JPEG, GIF or WebP image" }, 415);
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		const id = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
		await bucket.put(key(id), bytes, { httpMetadata: { contentType: type } });
		db.insert(images).values({ id }).onConflictDoNothing().run();
		return c.json({ id }, 201);
	});
	app.openapi(imageOperations.readImage, async (c) => {
		const { id } = c.req.valid("param");
		const object = await bucket.get(key(id));
		if (!object) return c.json({ error: "Image unavailable" }, 404);
		return new Response(object.body, {
			headers: {
				"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	});
	return app;
}
