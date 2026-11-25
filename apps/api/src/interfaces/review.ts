import { z } from "zod";
import { fixedSchedule, taskId, type Task } from "./plan.ts";

export const proposeTime = z.strictObject({
	id: z.uuid().describe("Stable ID for retries of this proposal"),
	taskId,
	revision: z.int().nonnegative(),
	after: fixedSchedule,
	reason: z.string().trim().min(1).max(500),
});
export const decision = z.strictObject({ decision: z.enum(["accept", "reject"]) });
export const timeProposal = proposeTime.extend({
	before: fixedSchedule,
	source: z.enum(["user", "copilot"]),
	status: z.enum(["pending", "accepted", "rejected", "undone"]),
	createdAt: z.iso.datetime(),
	decidedAt: z.iso.datetime().optional(),
	acceptedRevision: z.int().nonnegative().optional(),
	undoneAt: z.iso.datetime().optional(),
});
export const reviewItem = timeProposal.extend({ title: z.string() });
export const recentDecision = reviewItem.extend({ canUndo: z.boolean() });
export type TimeProposal = z.infer<typeof timeProposal>;
export type ReviewItem = z.infer<typeof reviewItem>;

export function sameTime(a: Task["schedule"], b: TimeProposal["after"]) {
	return (
		a?.type === "fixed" &&
		Date.parse(a.start) === Date.parse(b.start) &&
		Date.parse(a.end) === Date.parse(b.end)
	);
}
