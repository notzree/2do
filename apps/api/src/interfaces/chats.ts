import { z } from "zod";

export const chatTitle = z.strictObject({ title: z.string().trim().min(1).max(100) });
export const sideChat = chatTitle.extend({
  id: z.uuid(),
  createdAt: z.int().nonnegative(),
  archivedAt: z.int().nullable().optional(),
  lastActivity: z.string().optional(),
  needsAttention: z.int().nonnegative().optional(),
  branch: z
    .object({ messageId: z.string(), excerpt: z.string(), generation: z.string().optional() })
    .nullable()
    .optional(),
});
export const chatList = z.array(sideChat);
export type SideChat = z.infer<typeof sideChat>;
