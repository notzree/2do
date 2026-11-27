import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import {
  approvalPolicy,
  groupedChanges,
  inboxCounts,
  inboxDecision,
  inboxId,
  inboxItem,
  inboxItemBatch,
  inboxList,
  inboxMark,
  inboxPage,
  publishMessage,
  publishQuestion,
} from "../interfaces/agent-inbox.ts";
import { stableInboxKey, digestUuid } from "../core/agent-keys.ts";
import type { AgentContext, AgentInbox } from "../core/agent-inbox.ts";
import { jsonLimits } from "./json-body.ts";
import {
  accessErrors,
  conflict,
  jsonBody,
  jsonErrors,
  jsonResponse,
  missing,
  named,
} from "./responses.ts";
import type { PlannerCaller } from "./review.ts";

const itemResponse = {
  200: jsonResponse(named(inboxItem, "AgentInboxItem")),
  ...accessErrors,
  ...jsonErrors,
  404: missing,
  409: conflict,
};
export const inboxOperations = {
  readAgentInboxItems: createRoute({
    method: "post",
    path: "/api/agent/inbox-items",
    operationId: "readAgentInboxItems",
    summary: "Read existing inbox items for a conversation in one batch",
    middleware: jsonLimits(128 * 1024),
    request: { body: jsonBody(inboxItemBatch) },
    responses: { 200: jsonResponse(z.array(inboxItem)), ...accessErrors, ...jsonErrors },
  }),
  getAgentInboxCounts: createRoute({
    method: "get",
    path: "/api/agent/inbox-counts",
    operationId: "getAgentInboxCounts",
    summary: "Count unread and actionable inbox items",
    responses: { 200: jsonResponse(named(inboxCounts, "AgentInboxCounts")), ...accessErrors },
  }),
  proposeChanges: createRoute({
    method: "post",
    path: "/api/agent/changes",
    operationId: "proposeChanges",
    "x-mcp": true,
    middleware: jsonLimits(),
    summary:
      "Group interdependent local planner writes in one atomic change. Use generated planner tool names and arguments in steps.",
    request: { body: jsonBody(groupedChanges) },
    responses: itemResponse,
  }),
  listAgentInbox: createRoute({
    method: "get",
    path: "/api/agent/inbox",
    operationId: "listAgentInbox",
    "x-mcp": true,
    summary: "Search workspace-wide proposals, questions and updates. Use view=action and kind=proposal for all active proposals across chats; q searches their saved details. Follow nextCursor.",
    request: { query: inboxList },
    responses: { 200: jsonResponse(named(inboxPage, "AgentInboxPage")), ...accessErrors },
  }),
  readAgentInboxItem: createRoute({
    method: "get",
    path: "/api/agent/inbox/{id}",
    operationId: "readAgentInboxItem",
    "x-mcp": true,
    request: { params: inboxId },
    responses: itemResponse,
  }),
  markAgentInboxItem: createRoute({
    method: "patch",
    path: "/api/agent/inbox/{id}",
    operationId: "markAgentInboxItem",
    middleware: jsonLimits(),
    request: { params: inboxId, body: jsonBody(inboxMark) },
    responses: itemResponse,
  }),
  decideAgentInboxItem: createRoute({
    method: "post",
    path: "/api/agent/inbox/{id}/decision",
    operationId: "decideAgentInboxItem",
    middleware: jsonLimits(),
    request: { params: inboxId, body: jsonBody(inboxDecision) },
    responses: itemResponse,
  }),
  askUser: createRoute({
    method: "post",
    path: "/api/agent/questions",
    operationId: "askUser",
    "x-mcp": true,
    middleware: jsonLimits(),
    summary:
      "Ask the user a durable question with optional choices in this conversation. End this turn after publishing.",
    request: { body: jsonBody(publishQuestion) },
    responses: itemResponse,
  }),
  notifyUser: createRoute({
    method: "post",
    path: "/api/agent/notifications",
    operationId: "notifyUser",
    "x-mcp": true,
    middleware: jsonLimits(),
    summary: "Publish an informational inbox item. No answer is required.",
    request: { body: jsonBody(publishMessage) },
    responses: itemResponse,
  }),
  readApprovalPolicy: createRoute({
    method: "get",
    path: "/api/agent/approval",
    operationId: "readApprovalPolicy",
    responses: { 200: jsonResponse(named(approvalPolicy, "AgentApprovalPolicy")), ...accessErrors },
  }),
  updateApprovalPolicy: createRoute({
    method: "put",
    path: "/api/agent/approval",
    operationId: "updateApprovalPolicy",
    middleware: jsonLimits(),
    request: { body: jsonBody(approvalPolicy) },
    responses: { 200: jsonResponse(approvalPolicy), ...accessErrors, ...jsonErrors, 409: conflict },
  }),
};
export type InboxCaller = {
  Bindings: PlannerCaller["Bindings"] & AgentContext & { viewerConversation?: string };
};
async function publication<T extends { id?: string }>(value: T, kind: string, ctx?: AgentContext) {
  let id = value.id;
  if (!id && ctx?.conversation && ctx.submission) {
    const hash = await stableInboxKey([ctx.conversation, ctx.submission, kind, value]);
    id = digestUuid(hash);
  }
  return { ...value, id: id ?? crypto.randomUUID() };
}
export function agentInboxRoutes(inbox: AgentInbox) {
  const app = new OpenAPIHono<InboxCaller>();
  const op = inboxOperations;
  function human(fromAgent?: boolean) {
    if (fromAgent) throw new HTTPException(403, { message: "A user decision is required." });
  }
  return app
    .openapi(op.proposeChanges, async (c) =>
      c.json(await inbox.group(c.req.valid("json"), c.env ?? {}), 200),
    )
    .openapi(op.getAgentInboxCounts, (c) => c.json(inbox.counts(), 200))
    .openapi(op.readAgentInboxItems, (c) => c.json(inbox.getMany(c.req.valid("json").ids), 200))
    .openapi(op.listAgentInbox, (c) => c.json(inbox.list(c.req.valid("query")), 200))
    .openapi(op.readAgentInboxItem, (c) => c.json(inbox.get(c.req.valid("param").id), 200))
    .openapi(op.markAgentInboxItem, (c) => {
      human(c.env?.fromAgent);
      return c.json(inbox.mark(c.req.valid("param").id, c.req.valid("json")), 200);
    })
    .openapi(op.decideAgentInboxItem, async (c) => {
      human(c.env?.fromAgent);
      return c.json(
        await inbox.decide(c.req.valid("param").id, c.req.valid("json"), c.env?.viewerConversation),
        200,
      );
    })
    .openapi(op.askUser, async (c) =>
      c.json(
        await inbox.ask(
          await publication(c.req.valid("json"), "question", c.env),
          c.env?.conversation,
        ),
        200,
      ),
    )
    .openapi(op.notifyUser, async (c) =>
      c.json(
        inbox.publish(
          "notification",
          await publication(c.req.valid("json"), "notification", c.env),
          c.env?.conversation,
        ),
        200,
      ),
    )
    .openapi(op.readApprovalPolicy, (c) => c.json(inbox.policy(), 200))
    .openapi(op.updateApprovalPolicy, (c) => {
      human(c.env?.fromAgent);
      return c.json(inbox.configure(c.req.valid("json")), 200);
    });
}
