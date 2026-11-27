import { workspaceOperations } from './agents-workspace.ts';
import { deviceReceiptOperation } from "../agents/device-receipt.ts";
import { inboxOperations } from "./agent-inbox.ts";
import { reminderOperations } from "./reminders.ts";
import { carryoverOperations } from "./carryover.ts";
import { goalOperations } from "./goals.ts";
import { createRoute, OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import { jsonResponse } from "./responses.ts";
import { connectionOperations } from "./connections.ts";
import { chatOperations } from "./chats.ts";
import { imageOperations } from "./images.ts";
import { notebookOperations } from "./notebook.ts";
import { taskOperations } from "./tasks.ts";
import { summaryOperations } from "./task-summaries.ts";
import { reviewOperations } from "./review.ts";
import { reportOperations } from "./plugin-reports.ts";

export const publicOperations = {
  deviceReceipt: deviceReceiptOperation,
  health: createRoute({
    operationId: "health",
    method: "get",
    path: "/api/health",
    summary: "Check service health",
    security: [],
    responses: { 200: jsonResponse(z.object({ status: z.literal("ok") }).openapi("Health")) },
  }),
  openapi: createRoute({
    operationId: "openapi",
    method: "get",
    path: "/api/openapi.json",
    summary: "Read the API contract",
    security: [],
    responses: { 200: jsonResponse(z.looseObject({ openapi: z.string() }).openapi("OpenAPI")) },
  }),
};

export const plannerOperations = {
  ...workspaceOperations,
  ...inboxOperations,
  ...reminderOperations,
  ...reportOperations,
  ...carryoverOperations,
  ...goalOperations,
  ...reviewOperations,
  ...summaryOperations,
  ...chatOperations,
  ...notebookOperations,
  ...imageOperations,
  ...taskOperations,
};

export function openApiDocument() {
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerComponent("securitySchemes", "AccessSession", {
    type: "apiKey",
    in: "cookie",
    name: "CF_Authorization",
  });
  for (const route of Object.values({
    ...publicOperations,
    ...plannerOperations,
    ...connectionOperations,
  })) {
    // Runtime middleware belongs to the Worker and is not part of the document.
    const { middleware, ...definition }: RouteConfig = route;
    app.openAPIRegistry.registerPath(definition);
  }
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "2do Planner",
      version: "1.0.0",
      description:
        "Authenticated planner responses include an opaque X-Planner-Scope header. A client replaying a saved notebook write can send that value as a precondition. A different signed-in planner receives HTTP 412 before the command is executed.",
    },
    security: [{ AccessSession: [] }],
  });
}
