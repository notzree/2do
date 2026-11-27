import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { PlannerReminders } from "../core/reminders.ts";
import type { CommitTaskWrite } from "../interfaces/database.ts";
import {
  reminderInput,
  reminderRule,
  reminderSettings,
  reminderSubscription,
  remindersResponse,
} from "../interfaces/reminders.ts";
import {
  accessErrors,
  conflict,
  jsonBody,
  jsonErrors,
  jsonResponse,
  missing,
} from "./responses.ts";
import { jsonLimits } from "./json-body.ts";

const params = z.object({ id: z.uuid() });
const receipt = z.object({ id: z.uuid() });
const path = "/api/reminders/{id}";
const failures = { ...accessErrors, ...jsonErrors, 404: missing, 409: conflict };
const ok = { 200: jsonResponse(receipt), ...failures };
const occurrence = z.strictObject({ occurrence: z.uuid() });

export const reminderOperations = {
  listReminders: createRoute({
    operationId: "listReminders",
    method: "get",
    path: "/api/reminders",
    summary: "List reminder rules, delivery settings and their next wakeup",
    "x-mcp": true,
    responses: { 200: jsonResponse(remindersResponse), ...accessErrors },
  }),
  setReminderSettings: createRoute({
    operationId: "setReminderSettings",
    "x-mcp": true,
    method: "put",
    path: "/api/reminders/settings",
    summary: "Set notification timezone, pause, date-only time and quiet hours",
    middleware: jsonLimits(),
    request: { body: jsonBody(reminderSettings) },
    responses: { 200: jsonResponse(reminderSettings), ...failures },
  }),
  setReminder: createRoute({
    operationId: "setReminder",
    method: "put",
    path,
    summary:
      "Create or replace an absolute, task-relative, daily briefing or planner-wide due reminder rule by stable ID",
    "x-mcp": true,
    middleware: jsonLimits(),
    request: { params, body: jsonBody(reminderInput) },
    responses: { 200: jsonResponse(reminderRule), ...failures },
  }),
  deleteReminder: createRoute({
    operationId: "deleteReminder",
    method: "delete",
    path,
    summary: "Cancel a reminder and pending deliveries",
    "x-mcp": true,
    request: { params },
    responses: ok,
  }),
  snoozeReminder: createRoute({
    operationId: "snoozeReminder",
    method: "post",
    path: "/api/reminders/{id}/snooze",
    summary: "Snooze one delivered occurrence by its inbox notification ID",
    "x-mcp": true,
    middleware: jsonLimits(),
    request: { params, body: jsonBody(occurrence.extend({ minutes: z.int().min(1).max(10080) })) },
    responses: ok,
  }),
  dismissReminder: createRoute({
    operationId: "dismissReminder",
    method: "post",
    path: "/api/reminders/{id}/dismiss",
    summary: "Dismiss one reminder occurrence by its inbox notification ID",
    "x-mcp": true,
    middleware: jsonLimits(),
    request: { params, body: jsonBody(occurrence) },
    responses: ok,
  }),
  subscribeReminderPush: createRoute({
    operationId: "subscribeReminderPush",
    method: "put",
    path: "/api/reminders/push/{id}",
    summary: "Subscribe this device for planner notifications",
    middleware: jsonLimits(),
    request: { params, body: jsonBody(reminderSubscription) },
    responses: ok,
  }),
  unsubscribeReminderPush: createRoute({
    operationId: "unsubscribeReminderPush",
    method: "delete",
    path: "/api/reminders/push/{id}",
    summary: "Unsubscribe this device from planner notifications",
    request: { params },
    responses: ok,
  }),
};
export function reminderRoutes(service: PlannerReminders, commit: CommitTaskWrite) {
  const ops = reminderOperations;
  return new OpenAPIHono<{ Bindings: { viewerConversation?: string } }>()
    .openapi(ops.listReminders, (c) => c.json(service.list(), 200))
    .openapi(ops.setReminderSettings, async (c) =>
      c.json(await commit(() => service.configure(c.req.valid("json"))), 200),
    )
    .openapi(ops.setReminder, async (c) =>
      c.json(
        await commit(() =>
          service.set(
            c.req.valid("param").id,
            c.req.valid("json"),
            Date.now(),
            c.env?.viewerConversation,
          ),
        ),
        200,
      ),
    )
    .openapi(ops.deleteReminder, async (c) =>
      c.json(await commit(() => service.remove(c.req.valid("param").id)), 200),
    )
    .openapi(ops.snoozeReminder, async (c) =>
      c.json(
        await commit(() =>
          service.act(
            c.req.valid("param").id,
            c.req.valid("json").occurrence,
            c.req.valid("json").minutes,
          ),
        ),
        200,
      ),
    )
    .openapi(ops.dismissReminder, async (c) =>
      c.json(
        await commit(() => service.act(c.req.valid("param").id, c.req.valid("json").occurrence)),
        200,
      ),
    )
    .openapi(ops.subscribeReminderPush, async (c) =>
      c.json(
        await commit(() => service.subscribe(c.req.valid("param").id, c.req.valid("json"))),
        200,
      ),
    )
    .openapi(ops.unsubscribeReminderPush, async (c) =>
      c.json(await commit(() => service.unsubscribe(c.req.valid("param").id)), 200),
    );
}
