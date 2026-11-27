import { z } from "zod";
import { chatTitle } from "./chats.ts";

export const publicChatId = z.union([z.literal("me"), z.uuid()]);
export const chatScope = z.array(z.union([publicChatId, z.literal("active-sides")])).max(12);
export const branchChat = chatTitle.extend({
  id: z.uuid(),
  messageId: z.string().min(1).max(240),
  excerpt: z.string().trim().min(1).max(4000),
});
export const reportMilestone = z.strictObject({
  occurrence: z.string().trim().min(1).max(180),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2000),
  itemId: z.string().min(1).max(300).optional(),
  notebookDay: z.iso.date().optional(),
});
export const workspaceEvent = z.object({
  id: z.string(),
  chat: publicChatId,
  at: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  itemId: z.string().nullable(),
  messageId: z.string().nullable(),
  relatedChat: publicChatId.nullable(),
  relatedTitle: z.string().nullable().optional(),
  notebookDay: z.iso.date().nullable().optional(),
  generation: z.string().nullable(),
  deliveryStatus: z.string().nullable().optional(),
  deviceCallId: z.string().nullable().optional(),
});
export const activityQuery = z.object({
  chat: publicChatId.optional(),
  event: z.string().max(640).optional(),
  cursor: z.string().max(250).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export const activityPage = z.object({
  items: z.array(workspaceEvent),
  nextCursor: z.string().nullable(),
});
export const contextQuery = z.object({
  q: z.string().trim().min(1).max(240),
  chat: z.union([publicChatId, z.literal("active-sides")]).optional(),
});
export const contextMatches = z.array(
  z.object({
    chat: publicChatId,
    title: z.string(),
    messageId: z.string(),
    generation: z.string(),
    excerpt: z.string(),
    at: z.string(),
  }),
);
export type WorkspaceEvent = z.infer<typeof workspaceEvent>;
