import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Carryover } from "../core/carryover.ts";
import type { CommitTaskWrite } from "../interfaces/database.ts";
import { timeZone } from "../interfaces/plan.ts";
import { accessErrors, invalidInput, jsonBody, jsonErrors, jsonResponse } from "./responses.ts";

const settings = z.strictObject({ enabled: z.boolean(), timeZone });
const settingsPath = "/api/settings/carryover";
export const carryoverOperations = {
  carryOverTasks: createRoute({
    operationId: "carryOverTasks",
    method: "post",
    path: "/api/days/{date}/carryover",
    summary: "Move unfinished tasks from the previous calendar day",
    "x-mcp": true,
    request: {
      params: z.object({ date: z.iso.date() }),
      query: z.object({ timeZone: timeZone.optional() }),
    },
    responses: {
      200: jsonResponse(z.object({ from: z.iso.date(), to: z.iso.date(), moved: z.int() })),
      ...accessErrors,
      400: invalidInput,
    },
  }),
  readCarryoverSettings: createRoute({
    operationId: "readCarryoverSettings",
    "x-mcp": true,
    method: "get",
    path: settingsPath,
    summary: "Read automatic carryover settings",
    responses: { 200: jsonResponse(settings), ...accessErrors },
  }),
  setCarryoverSettings: createRoute({
    operationId: "setCarryoverSettings",
    "x-mcp": true,
    method: "put",
    path: settingsPath,
    summary: "Configure daily carryover at 6 AM in the selected time zone",
    request: { body: jsonBody(settings) },
    responses: { 200: jsonResponse(settings), ...accessErrors, ...jsonErrors },
  }),
};
export function carryoverRoutes(service: Carryover, commit: CommitTaskWrite) {
  return new OpenAPIHono()
    .openapi(carryoverOperations.carryOverTasks, async (c) =>
      c.json(
        await commit(() => service.run(c.req.valid("param").date, c.req.valid("query").timeZone)),
        200,
      ),
    )
    .openapi(carryoverOperations.readCarryoverSettings, (c) => c.json(service.settings(), 200))
    .openapi(carryoverOperations.setCarryoverSettings, async (c) =>
      c.json(await commit(() => service.configure(c.req.valid("json"))), 200),
    );
}
