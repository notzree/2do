import { dispatch } from "@flue/runtime";
import { ReminderBrief } from "./reminder-brief.ts";

export async function dispatchReminderBrief(scope: string, jobId: string, snapshot: string) {
  await dispatch(ReminderBrief, {
    id: scope + "/" + jobId,
    idempotencyKey: jobId,
    message: { kind: "signal", type: "planner_daily_brief", body: snapshot },
  });
}
