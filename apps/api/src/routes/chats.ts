import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { accessErrors, jsonBody, jsonErrors, jsonResponse, named } from "./responses.ts";
import { jsonLimits } from "./json-body.ts";
import { desc, eq } from "drizzle-orm";
import { sideChats } from "../db/schema.ts";
import type { PlannerStore } from "../db/planner.ts";
import { chatList, chatTitle, sideChat } from "../interfaces/chats.ts";

export const chatId = z.uuid();

export const chatOperations = {
	listChats: createRoute({
		operationId: "listChats",
		method: "get",
		path: "/api/chats",
		summary: "List side chats for this planner",
		responses: { 200: jsonResponse(named(chatList, "ChatList")), ...accessErrors },
	}),
	registerChat: createRoute({
		operationId: "registerChat",
		method: "put",
		path: "/api/chats/{id}",
		summary: "Register a side chat on its first message",
		middleware: jsonLimits(),
		request: { params: z.object({ id: chatId }), body: jsonBody(named(chatTitle, "ChatTitle")) },
		responses: { 200: jsonResponse(named(sideChat, "SideChat")), ...accessErrors, ...jsonErrors },
	}),
};

export function chatRoutes(db: PlannerStore) {
	const app = new OpenAPIHono();
	app.openapi(chatOperations.listChats, (c) =>
		c.json(db.select().from(sideChats).orderBy(desc(sideChats.createdAt), sideChats.id).all(), 200),
	);
	app.openapi(chatOperations.registerChat, (c) => {
		const { id } = c.req.valid("param");
		const { title } = c.req.valid("json");
		db.insert(sideChats).values({ id, title, createdAt: Date.now() }).onConflictDoNothing().run();
		return c.json(db.select().from(sideChats).where(eq(sideChats.id, id)).get()!, 200);
	});
	return app;
}
