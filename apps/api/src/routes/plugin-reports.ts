import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { PluginReports } from "../core/plugin-reports.ts";
import {
  createGoal,
  goal,
  goalHistory,
  metricDefinition,
  metricSeries,
  metricSeriesQuery,
  reportRange,
  reportSettings,
  updateGoal,
  writeReportSettings,
} from "../interfaces/plugin-reports.ts";
import { jsonLimits } from "./json-body.ts";
import {
  accessErrors,
  conflict,
  invalidInput,
  jsonBody,
  jsonErrors,
  jsonResponse,
  missing,
  named,
} from "./responses.ts";

const goalParams = z.object({ id: z.uuid() });
const goalResult = jsonResponse(named(goal, "PluginGoal"));

export const reportOperations = {
  getReportSettings: createRoute({
    method: "get",
    path: "/api/report-settings",
    operationId: "getReportSettings",
    "x-mcp": true,
    summary: "Read the planner reporting time zone",
    responses: { 200: jsonResponse(reportSettings), ...accessErrors },
  }),
  setReportSettings: createRoute({
    method: "put",
    path: "/api/report-settings",
    operationId: "setReportSettings",
    "x-mcp": true,
    summary: "Set the reporting time zone; onlyIfUnset initializes it on the first device",
    middleware: jsonLimits(),
    request: { body: jsonBody(writeReportSettings) },
    responses: { 200: jsonResponse(reportSettings), ...accessErrors, ...jsonErrors },
  }),
  listPluginMetrics: createRoute({
    method: "get",
    path: "/api/plugin-metrics",
    operationId: "listPluginMetrics",
    "x-mcp": true,
    summary: "List metrics contributed by enabled plugins",
    responses: { 200: jsonResponse(z.array(metricDefinition)), ...accessErrors },
  }),
  readMetricSeries: createRoute({
    method: "get",
    path: "/api/plugin-metrics/{metricId}/series",
    operationId: "readMetricSeries",
    "x-mcp": true,
    summary: "Read confirmed metric sums and coverage across a half-open civil-date range",
    request: {
      params: z.object({ metricId: metricDefinition.shape.id }),
      query: metricSeriesQuery,
    },
    responses: {
      200: jsonResponse(named(metricSeries, "MetricSeries")),
      400: invalidInput,
      404: missing,
      ...accessErrors,
    },
  }),
  listGoals: createRoute({
    method: "get",
    path: "/api/goals",
    operationId: "listGoals",
    "x-mcp": true,
    summary: "List goals for enabled metrics with their effective-dated targets",
    responses: { 200: jsonResponse(z.array(goal)), ...accessErrors },
  }),
  createGoal: createRoute({
    method: "post",
    path: "/api/goals",
    operationId: "createGoal",
    "x-mcp": true,
    summary: "Create a daily goal for an enabled plugin metric",
    middleware: jsonLimits(),
    request: { body: jsonBody(createGoal) },
    responses: { 201: goalResult, ...accessErrors, ...jsonErrors, 404: missing, 409: conflict },
  }),
  updateGoal: createRoute({
    method: "put",
    path: "/api/goals/{id}",
    operationId: "updateGoal",
    "x-mcp": true,
    summary: "Change a daily target or end the goal on the effective date",
    middleware: jsonLimits(),
    request: { params: goalParams, body: jsonBody(updateGoal) },
    responses: { 200: goalResult, ...accessErrors, ...jsonErrors, 404: missing, 409: conflict },
  }),
  readAllGoalHistory: createRoute({
    method: "get",
    path: "/api/goals/history",
    operationId: "readAllGoalHistory",
    "x-mcp": true,
    summary: "Read daily outcomes and counts for all goals over a calendar range",
    request: { query: reportRange },
    responses: { 200: jsonResponse(z.array(goalHistory)), 400: invalidInput, ...accessErrors },
  }),
  readGoalHistory: createRoute({
    method: "get",
    path: "/api/goals/{id}/history",
    operationId: "readGoalHistory",
    "x-mcp": true,
    summary: "Count daily outcomes using the target in effect each day",
    request: { params: goalParams, query: reportRange },
    responses: { 200: jsonResponse(goalHistory), 400: invalidInput, 404: missing, ...accessErrors },
  }),
};

export function pluginReportRoutes(reports: PluginReports) {
  const app = new OpenAPIHono();
  const op = reportOperations;
  app.openapi(op.getReportSettings, (c) => c.json(reports.db.settings(), 200));
  app.openapi(op.setReportSettings, (c) => {
    const { timeZone, onlyIfUnset } = c.req.valid("json");
    return c.json(reports.db.setTimeZone(timeZone, onlyIfUnset), 200);
  });
  app.openapi(op.listPluginMetrics, (c) => c.json(reports.metrics(), 200));
  app.openapi(op.readMetricSeries, (c) =>
    c.json(reports.series(c.req.valid("param").metricId, c.req.valid("query")), 200),
  );
  app.openapi(op.listGoals, (c) => c.json(reports.goals(), 200));
  app.openapi(op.createGoal, (c) => c.json(reports.create(c.req.valid("json")), 201));
  app.openapi(op.updateGoal, (c) =>
    c.json(reports.update(c.req.valid("param").id, c.req.valid("json")), 200),
  );
  app.openapi(op.readAllGoalHistory, (c) => c.json(reports.allHistory(c.req.valid("query")), 200));
  app.openapi(op.readGoalHistory, (c) =>
    c.json(reports.history(c.req.valid("param").id, c.req.valid("query")), 200),
  );
  return app;
}
