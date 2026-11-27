import {inboxItem} from "../interfaces/agent-inbox.ts";
import {jsonLimits} from "./json-body.ts";
import { createRoute, z } from "@hono/zod-openapi";
import {
  connectorKind,
  connectorStatus,
  directions,
  calendarLinkStatus,
} from "../interfaces/connectors.ts";
import { jsonBody, jsonResponse, accessErrors, conflict, invalidInput } from "./responses.ts";
const params = z.object({ kind: connectorKind });
const eventParams = z.object({ id: z.uuid() });
const linkResponse = jsonResponse(z.object({ status: calendarLinkStatus }));
export const connectionGuideResult=z.union([inboxItem,z.object({status:z.literal("complete"),text:z.string()})]);
export const connectionOperations = {
  guide:createRoute({method:"post",path:"/api/connections/guide",operationId:"guideGoogleConnection","x-mcp":true,
    summary:"Help connect Gmail, Google Calendar or Google Health (Fitbit); collect missing choices and consent through the user's inbox.",
    middleware:jsonLimits(), request:{body:jsonBody(z.strictObject({kind:connectorKind.optional()}))},
    responses:{200:jsonResponse(connectionGuideResult),...accessErrors},
  }),
  status: createRoute({
    method: "get",
    path: "/api/connections/{kind}",
    operationId: "connectionStatus",
    "x-mcp": true,
    request: { params },
    responses: { 200: jsonResponse(connectorStatus), ...accessErrors },
  }),
  begin: createRoute({
    method: "post",
    path: "/api/connections/{kind}/authorize",
    operationId: "authorizeConnection",
    request: { params, body: jsonBody(z.union([directions, z.strictObject({})])) },
    responses: { 200: jsonResponse(z.object({ url: z.url() })), 400: invalidInput, ...accessErrors },
  }),
  callback: createRoute({
    method: "get",
    path: "/api/connections/{kind}/callback",
    operationId: "completeConnection",
    request: {
      params,
      query: z.object({
        state: z.string(),
        code: z.string().optional(),
        error: z.string().optional(),
      }),
    },
    responses: {
      303: { description: "Return to Connections settings" },
      400: { description: "Invalid or declined consent" },
      ...accessErrors,
    },
  }),
  recentWorkouts: createRoute({
    method: "get", path: "/api/connections/google-health/workouts", operationId: "recentWearableWorkouts",
    responses: {200: jsonResponse(z.array(z.object({activity:z.string(), start:z.iso.datetime(), minutes:z.number(), km:z.number().nullable()}))), ...accessErrors},
  }),
  mailSuggestions: createRoute({
    method: "put", path: "/api/connections/gmail/suggestions", operationId: "setMailSuggestions",
    summary: "Allow new Gmail subjects and excerpts to be analyzed for task proposals",
    request: {body: jsonBody(z.strictObject({enabled:z.boolean()}))},
    responses: {200:jsonResponse(z.object({enabled:z.boolean()})), 409:conflict, ...accessErrors},
  }),
  options: createRoute({
    method: "put",
    path: "/api/connections/google-calendar/options",
    operationId: "calendarSyncDirections",
    "x-mcp": true,
    request: { body: jsonBody(directions) },
    responses: { 200: jsonResponse(z.object({ authorized: z.boolean() })), ...accessErrors },
  }),
  remove: createRoute({
    method: "delete",
    path: "/api/connections/{kind}",
    operationId: "disconnectProvider",
    "x-mcp": true,
    request: { params },
    responses: { 204: { description: "Disconnected" }, ...accessErrors },
  }),
  link: createRoute({
    method: "put",
    path: "/api/events/{id}/calendar-link",
    operationId: "setCalendarLink",
    "x-mcp": true,
    request: { params: eventParams, body: jsonBody(z.strictObject({ enabled: z.boolean() })) },
    responses: { 200: linkResponse, 409: conflict, ...accessErrors },
  }),
  deleteEvent: createRoute({
    method: "delete",
    path: "/api/events/{id}/calendar-link",
    operationId: "deletePublishedEvent",
    "x-mcp": true,
    request: {
      params: eventParams,
      query: z.object({ revision: z.coerce.number().int().nonnegative() }),
    },
    responses: {
      202: jsonResponse(z.object({ queued: z.literal(true) })),
      409: conflict,
      ...accessErrors,
    },
  }),
  readLink: createRoute({
    method: "get",
    path: "/api/events/{id}/calendar-link",
    operationId: "getCalendarLink",
    "x-mcp": true,
    request: { params: eventParams },
    responses: { 200: linkResponse, ...accessErrors },
  }),
};
