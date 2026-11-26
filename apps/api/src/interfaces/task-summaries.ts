import { z } from "zod";
import { taskId } from "./plan.ts";
import { eligibleTaskPrompt, taskDetails, taskSubtype, taskTypeIcon } from "./task-plugins.ts";

export const summaryBatchSize = 64;
export const summaryRequest = z.strictObject({ ids: z.array(taskId).min(1).max(summaryBatchSize) });
export const taskSummary = z.strictObject({
  id: taskId,
  extracting: taskDetails.shape.extracting,
  classification: taskDetails.shape.classification,
  types: z.array(taskSubtype.pick({ typeId: true, source: true }).extend({
    label: z.string(), icon: taskTypeIcon.optional(),
  })),
  inlays: z.array(
    z.strictObject({ typeId: z.string(), field: z.string(), label: z.string(), value: z.string() }),
  ),
  prompts: z.array(eligibleTaskPrompt.extend({ skipped: z.boolean() })),
});
export const taskSummaries = z.array(taskSummary);
export type TaskSummary = z.infer<typeof taskSummary>;
