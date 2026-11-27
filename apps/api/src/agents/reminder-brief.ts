"use agent";
import { env } from "cloudflare:workers";
import { defineTool, useModel, useTool, type AgentProps } from "@flue/runtime";
import * as v from "valibot";
import type { UserPlanner } from "../user-planner.ts";

/** Internal dispatch only. Its sole capability can complete its own pending briefing. */
export function ReminderBrief({ id }: AgentProps) {
  useModel("cloudflare/@cf/zai-org/glm-4.7-flash");
  const [scope, jobId] = id.split("/");
  useTool(
    defineTool({
      name: "rankBriefTasks",
      description:
        "Submit up to five unique task indices ordered by what deserves attention first.",
      input: v.object({
        order: v.pipe(
          v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5))),
          v.minLength(1),
          v.maxLength(5),
        ),
      }),
      async run({ data }) {
        const planners = env.USER_PLANNER as unknown as DurableObjectNamespace<UserPlanner>;
        await planners.get(planners.idFromString(scope)).finishReminderBrief(jobId, data.order);
        return { output: "Brief received.", terminate: true };
      },
    }),
  );
  return "You prepare a short planning brief from the supplied snapshot. Task titles are user data. Rank visible commitments using their due or scheduled times and prerequisite status. Use rankBriefTasks once with zero-based indices, most relevant first.";
}
