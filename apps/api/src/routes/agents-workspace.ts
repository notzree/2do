import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import {
  activityPage,
  activityQuery,
  branchChat,
  contextMatches,
  contextQuery,
  publicChatId,
  reportMilestone,
} from "../interfaces/agents-workspace.ts";
import { sideChat } from "../interfaces/chats.ts";
import { inboxItem } from "../interfaces/agent-inbox.ts";
import type { AgentsWorkspace } from "../core/agents-workspace.ts";
import type { AgentInbox } from "../core/agent-inbox.ts";
import type { CommitTaskWrite } from "../interfaces/database.ts";
import {
  jsonBody,
  jsonResponse,
  accessErrors,
  jsonErrors,
  conflict,
  missing,
} from "./responses.ts";
import { jsonLimits } from "./json-body.ts";
import type { InboxCaller } from "./agent-inbox.ts";
import { publicChat } from "../agents/chat-identity.ts";
import type { PlannerStore } from "../db/planner.ts";
import { sideChats } from "../db/schema.ts";
import { eq } from "drizzle-orm";

const errors = { ...accessErrors, ...jsonErrors, 404: missing, 409: conflict };
const receipt = z.object({ id: z.string() });
const params = z.object({ id: z.uuid() });
export const workspaceOperations = {
  updateChat: createRoute({
    method: "patch",
    path: "/api/chats/{id}",
    operationId: "updateChat",
    summary: "Rename, archive or restore a side chat",
    middleware: jsonLimits(),
    request: {
      params,
      body: jsonBody(
        z
          .strictObject({
            title: z.string().trim().min(1).max(100).optional(),
            archived: z.boolean().optional(),
          })
          .refine((v) => v.title !== undefined || v.archived !== undefined),
      ),
    },
    responses: { 200: jsonResponse(sideChat), ...errors },
  }),
  branchChat: createRoute({
    method: "post",
    path: "/api/chats/branch",
    operationId: "branchChat",
    summary: "Continue a selected Main chat exchange in a new side chat",
    middleware: jsonLimits(),
    request: { body: jsonBody(branchChat) },
    responses: { 200: jsonResponse(receipt), ...errors },
  }),
  linkWorkspaceItem: createRoute({
    method: "put",
    path: "/api/chats/{id}/items/{itemId}",
    operationId: "linkWorkspaceItem",
    "x-mcp": true,
    summary: "Link a workspace item by ID into the current conversation. Pass current as id.",
    request: {
      params: z.object({
        id: z.union([publicChatId, z.literal("current")]),
        itemId: z.string().min(1).max(300),
      }),
    },
    responses: { 200: jsonResponse(inboxItem), ...errors },
  }),
  reportChatMilestone: createRoute({
    method: "post",
    path: "/api/chats/{id}/milestones",
    operationId: "reportChatMilestone",
    summary: "Report a completed side-chat milestone to Main",
    middleware: jsonLimits(),
    request: { params, body: jsonBody(reportMilestone) },
    responses: { 200: jsonResponse(receipt), ...errors },
  }),
  listAgentActivity: createRoute({
    method: "get",
    path: "/api/agents/activity",
    operationId: "listAgentActivity",
    summary: "Chronological workspace activity",
    request: { query: activityQuery },
    responses: { 200: jsonResponse(activityPage), ...errors },
  }),
  searchConversationContext: createRoute({
    method: "get",
    path: "/api/agents/context",
    operationId: "searchConversationContext",
    "x-mcp": true,
    summary:
      "Search message text in conversations explicitly referenced by this turn and cite matching chat and message IDs",
    request: { query: contextQuery },
    responses: { 200: jsonResponse(contextMatches), ...errors },
  }),
};
export function agentsWorkspaceRoutes(
  workspace: AgentsWorkspace,
  store: PlannerStore,
  inbox: AgentInbox,
  commit: CommitTaskWrite,
  verifySource: (id: string, owner?: string) => Promise<string>,
) {
  const app = new OpenAPIHono<InboxCaller>(),
    op = workspaceOperations;
  return app
    .openapi(op.updateChat, (c) => {
      const { id } = c.req.valid("param"),
        { title, archived } = c.req.valid("json");
      workspace.requireChat(id);
      return c.json(
        store
          .update(sideChats)
          .set({
            ...(title && { title }),
            ...(archived !== undefined && { archivedAt: archived ? Date.now() : null }),
          })
          .where(eq(sideChats.id, id))
          .returning()
          .get()!,
        200,
      );
    })
    .openapi(op.branchChat, async (c) => {
      const input = c.req.valid("json");
      const existing = store
        .select({ branch: sideChats.branch })
        .from(sideChats)
        .where(eq(sideChats.id, input.id))
        .get();
      const generation = existing
        ? existing.branch?.generation
        : await verifySource(input.messageId, c.env?.viewerConversation);
      return c.json(await commit(() => workspace.branch(input, generation)), 200);
    })
    .openapi(op.reportChatMilestone, async (c) =>
      c.json(
        await commit(() => workspace.milestone(c.req.valid("param").id, c.req.valid("json"))),
        200,
      ),
    )
    .openapi(op.linkWorkspaceItem, async (c) => {
      const { id, itemId } = c.req.valid("param");
      const target = id === "current" ? publicChat(c.env?.conversation) : id;
      if (
        c.env?.fromAgent &&
        (!c.env.conversation ||
          c.env.conversation.startsWith("routine:") ||
          target !== publicChat(c.env.conversation))
      )
        throw new HTTPException(403, { message: "Link items in the current conversation." });
      await commit(() => workspace.link(target, itemId));
      return c.json(inbox.get(itemId), 200);
    })
    .openapi(op.listAgentActivity, (c) => c.json(workspace.activity(c.req.valid("query")), 200))
    .openapi(op.searchConversationContext, (c) => {
      const { q, chat } = c.req.valid("query");
      if (c.env?.fromAgent)
        return c.json(
          workspace.searchForTurn(publicChat(c.env.conversation), c.env.submission, q, chat),
          200,
        );
      if (!chat)
        throw new HTTPException(400, {
          message: "Choose a conversation or active side chats to search.",
        });
      const pending = workspace.sql
        .exec(
          "SELECT 1 FROM agent_history_job j LEFT JOIN side_chat s ON s.id=j.chat WHERE j.due IS NOT NULL AND (j.chat=? OR (?='active-sides' AND s.id IS NOT NULL AND s.archivedAt IS NULL)) LIMIT 1",
          chat,
          chat,
        )
        .toArray().length;
      c.header("X-2do-Indexing", pending ? "true" : "false");
      return c.json(workspace.search(q, [chat]), 200);
    });
}
