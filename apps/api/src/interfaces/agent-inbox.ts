import { elicitationReply, elicitationView } from "./elicitation.ts";
import { z } from "zod";

export const inboxChange = z.object({ field: z.string(), before: z.unknown(), after: z.unknown() });
export const inboxStatus = z.enum([
  "pending",
  "applied",
  "rejected",
  "answered",
  "revision-requested",
  "published",
  "stale",
  "queued",
  "failed",
  "undone",
]);
export const inboxItem = z.object({
  id: z.string(),
  kind: z.enum(["proposal", "question", "notification"]),
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
  version: z.number().int(),
  read: z.boolean(),
  archived: z.boolean(),
  status: inboxStatus,
  changes: z.array(inboxChange),
  taskTitles: z.record(z.string(), z.string()).optional(),
  choices: z.array(z.string()),
  elicitation: elicitationView.optional(),
  deviceCallId:z.string().optional(),
  conversation: z.string().optional(),
  references: z.array(z.string()).optional(),
  replaces: z.string().optional(),
  replacementId: z.string().optional(),
  nextItemId: z.string().optional(),
  taskId: z.string().optional(),
  reminderId: z.string().optional(),
  expiresAt: z.iso.datetime().optional(),
  answer: z.string().optional(),
  source: z.string().optional(),
});
export const inboxCounts = z.object({
  unread: z.number().int(),
  needsAction: z.number().int(),
});
export const inboxPage = inboxCounts.extend({
  items: z.array(inboxItem),
  nextCursor: z.string().nullable(),
});
export const inboxEffect = z.enum([
  "local-edit",
  "local-create",
  "local-delete",
  "workflow",
  "settings",
  "external",
]);
export const approvalRule = z.strictObject({
  effect: inboxEffect,
  mode: z.enum(["ask", "allow"]),
  origin: z.enum(["chat", "scheduled"]),
  operations: z.array(z.string().min(1).max(100)).min(1).max(64).optional(),
  resourceIds: z.array(z.string().min(1).max(300)).min(1).max(128).optional(),
  maxResources: z.int().min(1).max(10000).optional(),
  reversibleOnly: z.boolean().optional(),
  account: z.string().trim().min(1).max(320).optional(),
});
export const approvalPolicy = z.strictObject({
  revision: z.int().nonnegative(),
  rules: z.array(approvalRule).max(64),
});
export const inboxDecision = z.strictObject({
  version: z.int().positive(),
  elicitation: elicitationReply.optional(),
  decision: z.enum(["approve", "reject", "answer", "revise"]),
  answer: z.string().trim().min(1).max(2000).optional(),
});
export const inboxMark = z
  .strictObject({ read: z.boolean().optional(), archived: z.boolean().optional() })
  .refine((p) => p.read !== undefined || p.archived !== undefined);
export const inboxId = z.object({ id: z.string().min(1).max(300) });
export const inboxItemBatchSize = 64;
export const inboxItemBatch = z.strictObject({ ids: z.array(inboxId.shape.id).min(1).max(inboxItemBatchSize) });
export const inboxList = z.object({
  view: z.enum(["all", "action", "updates"]).default("all"),
  chat: z.union([z.literal("me"), z.uuid()]).optional(),
  kind: z.enum(["proposal","question","notification"]).optional(),
  q: z.string().trim().max(240).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const publishMessage = z.strictObject({
  id: z.uuid().optional().describe("Optional stable ID for replay"),
  title: z.string().trim().min(1).max(240),
  body: z.string().max(4000),
  taskId: z.uuid().optional(),
});
export const publishQuestion = publishMessage.extend({
  expiresAt: z.iso.datetime().optional(),
  choices: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
});
export type InboxChange = z.infer<typeof inboxChange>;
export type InboxItem = z.infer<typeof inboxItem>;
export type InboxPage = z.infer<typeof inboxPage>;
export type ApprovalPolicy = z.infer<typeof approvalPolicy>;
export type InboxDecision = z.infer<typeof inboxDecision>;
export type InboxEffect = z.infer<typeof inboxEffect>;

export const groupedChanges = z.strictObject({
  id: z.uuid(),
  expiresAt: z.iso.datetime().optional(),
  title: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(1500),
  steps: z
    .array(
      z.strictObject({
        operation: z.string().min(1).max(100),
        args: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(16),
});
export type GroupedChanges = z.infer<typeof groupedChanges>;
