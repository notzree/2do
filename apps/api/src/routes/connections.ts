import { createRoute, z } from "@hono/zod-openapi";
import {
  connectorKind,
  connectorStatus,
  directions,
  calendarLinkStatus,
} from "../interfaces/connectors.ts";
import { jsonBody, jsonResponse, accessErrors, conflict } from "./responses.ts";
const params = z.object({ kind: connectorKind });
const eventParams = z.object({ id: z.uuid() });
const linkResponse = jsonResponse(z.object({ status: calendarLinkStatus }));
export const connectionOperations = {
  status: createRoute({
    method: "get",
    path: "/api/connections/{kind}",
    operationId: "connectionStatus",
    request: { params },
    responses: { 200: jsonResponse(connectorStatus), ...accessErrors },
  }),
  begin: createRoute({
    method: "post",
    path: "/api/connections/{kind}/authorize",
    operationId: "authorizeConnection",
    request: { params, body: jsonBody(directions) },
    responses: { 200: jsonResponse(z.object({ url: z.url() })), ...accessErrors },
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
  options: createRoute({
    method: "put",
    path: "/api/connections/google-calendar/options",
    operationId: "calendarSyncDirections",
    request: { body: jsonBody(directions) },
    responses: { 200: jsonResponse(z.object({ authorized: z.boolean() })), ...accessErrors },
  }),
  remove: createRoute({
    method: "delete",
    path: "/api/connections/{kind}",
    operationId: "disconnectProvider",
    request: { params },
    responses: { 204: { description: "Disconnected" }, ...accessErrors },
  }),
  link: createRoute({
    method: "put",
    path: "/api/events/{id}/calendar-link",
    operationId: "setCalendarLink",
    request: { params: eventParams, body: jsonBody(z.strictObject({ enabled: z.boolean() })) },
    responses: { 200: linkResponse, 409: conflict, ...accessErrors },
  }),
  deleteEvent: createRoute({
    method: "delete",
    path: "/api/events/{id}/calendar-link",
    operationId: "deletePublishedEvent",
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
    request: { params: eventParams },
    responses: { 200: linkResponse, ...accessErrors },
  }),
};
