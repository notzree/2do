import { z } from "zod";

export const imageId = z.string().regex(/^[a-f0-9]{64}$/);
export const imageReceipt = z.strictObject({ id: imageId });
export const imageMimeTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const maxImageBytes = 8 * 1024 * 1024;
