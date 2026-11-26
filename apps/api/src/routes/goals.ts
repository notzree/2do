import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { PlannerGoals } from "../core/goals.ts";
import { goalProgress, editPlannerGoal, newPlannerGoal, plannerGoal } from "../interfaces/goals.ts";
import { jsonLimits } from "./json-body.ts";
import {
  accessErrors,
  conflict,
  jsonBody,
  jsonErrors,
  jsonResponse,
  missing,
} from "./responses.ts";

const result = jsonResponse(plannerGoal);
export const goalOperations = {
  listPlannerGoals: createRoute({
    method: "get",
    path: "/api/planner-goals",
    operationId: "listPlannerGoals",
    "x-mcp": true,
    summary: "Read planner goals, linked tasks, check-ins and plugin progress",
    responses: { 200: jsonResponse(z.array(plannerGoal)), ...accessErrors },
  }),
  createPlannerGoal: createRoute({
    method: "post",
    path: "/api/planner-goals",
    operationId: "createPlannerGoal",
    "x-mcp": true,
    summary: "Create a personal goal with optional dates and plugin criteria",
    middleware: jsonLimits(),
    request: { body: jsonBody(newPlannerGoal) },
    responses: { 201: result, 409: conflict, ...jsonErrors, ...accessErrors },
  }),
  readGoalProgress: createRoute({
    method: "get",
    path: "/api/planner-goals/{id}/progress",
    operationId: "readGoalProgress",
    "x-mcp": true,
    summary:
      "Evaluate the current goal rule against recorded evidence through the selected civil day",
    request: { params: z.object({ id: z.uuid() }), query: z.object({ day: z.iso.date() }) },
    responses: { 200: jsonResponse(goalProgress.nullable()), 404: missing, ...accessErrors },
  }),
  editPlannerGoal: createRoute({
    method: "patch",
    path: "/api/planner-goals/{id}",
    operationId: "editPlannerGoal",
    "x-mcp": true,
    summary: "Edit a goal, record a check-in, or change a task contribution or completion link",
    middleware: jsonLimits(),
    request: { params: z.object({ id: z.uuid() }), body: jsonBody(editPlannerGoal) },
    responses: { 200: result, 404: missing, 409: conflict, ...jsonErrors, ...accessErrors },
  }),
};
export function goalRoutes(goals: PlannerGoals) {
  const app = new OpenAPIHono();
  app.openapi(goalOperations.listPlannerGoals, (c) => c.json(goals.list(), 200));
  app.openapi(goalOperations.createPlannerGoal, (c) =>
    c.json(goals.create(c.req.valid("json")), 201),
  );
  app.openapi(goalOperations.readGoalProgress, (c) =>
    c.json(goals.progress(c.req.valid("param").id, c.req.valid("query").day), 200),
  );
  app.openapi(goalOperations.editPlannerGoal, (c) =>
    c.json(goals.edit(c.req.valid("param").id, c.req.valid("json")), 200),
  );
  return app;
}
