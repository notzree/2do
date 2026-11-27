import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import type { UserPlanner } from "../user-planner.ts";
import { env } from "cloudflare:workers";
import { plannerOwner, publicChat } from "./chat-identity.ts";
export function milestoneTool(conversation: string) {
  return defineTool({
    name: "reportMilestoneToMain",
    description:
      "Publish a concise completed outcome from this side chat to Main and wake the main assistant. Use a stable occurrence ID for the same milestone, preferably the completed workspace item ID. Return once the report is durably queued.",
    input: v.object({
      occurrence: v.pipe(v.string(), v.minLength(1), v.maxLength(180)),
      title: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
      body: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
      itemId: v.optional(v.string()),
      notebookDay: v.optional(v.pipe(v.string(), v.isoDate())),
    }),
    async run({ data }) {
      const owner = plannerOwner(conversation);
      const { id } = await (env.USER_PLANNER as unknown as DurableObjectNamespace<UserPlanner>)
        .getByName(owner)
        .publishChatMilestone(owner, publicChat(conversation), data);
      return { output: { reportId: id, status: "queued" } };
    },
  });
}
