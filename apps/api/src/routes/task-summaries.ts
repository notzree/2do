import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { TaskSummaries } from "../core/task-summaries.ts";
import { taskId } from "../interfaces/plan.ts";
import { summaryRequest, taskSummaries } from "../interfaces/task-summaries.ts";
import { jsonLimits } from "./json-body.ts";
import { accessErrors, jsonBody, jsonErrors, jsonResponse, missing, named } from "./responses.ts";

export const summaryOperations = {
  readTaskSummaries: createRoute({
    operationId: "readTaskSummaries",
    method: "post",
    path: "/api/tasks/summaries",
    summary: "Read plugin hints for a batch of notebook rows. Unknown tasks are omitted.",
    middleware: jsonLimits(),
    request: { body: jsonBody(summaryRequest) },
    responses: {
      200: jsonResponse(named(taskSummaries, "TaskSummaries")),
      ...accessErrors,
      ...jsonErrors,
    },
  }),
  setTaskPromptSkipped: createRoute({
    operationId: "setTaskPromptSkipped",
    method: "put",
    path: "/api/tasks/{id}/prompts/{promptId}",
    summary: "Skip or restore an eligible optional task hint",
    middleware: jsonLimits(),
    request: {
      params: z.object({ id: taskId, promptId: z.string().min(1).max(256) }),
      body: jsonBody(z.strictObject({ skipped: z.boolean() })),
    },
    responses: {
      204: { description: "Preference saved" },
      ...accessErrors,
      ...jsonErrors,
      404: missing,
    },
  }),
};

export function taskSummaryRoutes(summaries: TaskSummaries) {
  const app = new OpenAPIHono();
  app.openapi(summaryOperations.readTaskSummaries, (c) =>
    c.json(summaries.read(c.req.valid("json").ids), 200),
  );
  app.openapi(summaryOperations.setTaskPromptSkipped, (c) => {
    const { id, promptId } = c.req.valid("param");
    summaries.setSkipped(id, promptId, c.req.valid("json").skipped);
    return c.body(null, 204);
  });
  return app;
}
