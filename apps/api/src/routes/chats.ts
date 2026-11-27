import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { accessErrors, jsonBody, jsonErrors, jsonResponse, named } from "./responses.ts";
import { jsonLimits } from "./json-body.ts";
import type {AgentsWorkspace} from "../core/agents-workspace.ts";
import { desc, eq, isNull } from "drizzle-orm";
import { sideChats } from "../db/schema.ts";
import type { PlannerStore } from "../db/planner.ts";
import { chatList, chatTitle, sideChat } from "../interfaces/chats.ts";

export const chatId = z.uuid();

export const chatOperations = {
	listChats: createRoute({
		operationId: "listChats",
		"x-mcp": true,
		method: "get",
		path: "/api/chats",
		summary: "List active side chats, or the full directory with archive and activity metadata",
		request:{query:z.object({view:z.literal("directory").optional()})},
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

export function chatRoutes(db: PlannerStore,workspace:AgentsWorkspace) {
	const app = new OpenAPIHono();
  const basic={id:sideChats.id,title:sideChats.title,createdAt:sideChats.createdAt};
  app.openapi(chatOperations.listChats,c=>{
    if(!c.req.valid("query").view)return c.json(db.select(basic).from(sideChats).where(isNull(sideChats.archivedAt)).orderBy(desc(sideChats.createdAt),sideChats.id).all(),200);
    const stats=workspace.directoryStats();
    const rows=db.select().from(sideChats).all().map(chat=>({...chat,...stats.get(chat.id)}));
    return c.json(rows.sort((a,b)=>(b.lastActivity?Date.parse(b.lastActivity):b.createdAt)-(a.lastActivity?Date.parse(a.lastActivity):a.createdAt)||a.id.localeCompare(b.id)),200);
  });
	app.openapi(chatOperations.registerChat, (c) => {
		const { id } = c.req.valid("param");
		const { title } = c.req.valid("json");
		db.insert(sideChats).values({ id, title, createdAt: Date.now() }).onConflictDoNothing().run();
		return c.json(db.select(basic).from(sideChats).where(eq(sideChats.id, id)).get()!, 200);
	});
	return app;
}
