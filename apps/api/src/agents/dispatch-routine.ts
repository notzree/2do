import { dispatch } from "@flue/runtime";
import { Copilot } from "./copilot.ts";

export async function dispatchRoutine(
  owner: string,
  runId: string,
  instruction: string,
  day: string,
  zone: string,
) {
  await dispatch(Copilot, {
    id: `routine:${runId}:${owner}`,
    idempotencyKey: runId,
    message: {
      kind: "signal",
      type: "planner_routine",
      body: instruction,
      attributes: { localDate: day, timeZone: zone },
    },
  });
}
