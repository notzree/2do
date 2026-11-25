import { z } from "zod";

export const chatTitle = z.strictObject({ title: z.string().trim().min(1).max(100) });
export const sideChat = chatTitle.extend({ id: z.uuid(), createdAt: z.int().nonnegative() });
export const chatList = z.array(sideChat);
export type SideChat = z.infer<typeof sideChat>;
