import { imageReceipt, imageMimeTypes, maxImageBytes } from "@2do/api/notebook";
import { api } from "./query.ts";

export async function uploadImage(file: File) {
  if (file.size > maxImageBytes) throw new Error("Choose an image of 8 MiB or less.");
  if (!imageMimeTypes.some((type) => type === file.type))
    throw new Error("Choose a PNG, JPEG, GIF or WebP image.");
  const { data } = await api.POST("/api/images", {
    body: file,
    bodySerializer: (body) => body,
    headers: { "Content-Type": file.type },
  });
  return imageReceipt.parse(data).id;
}
