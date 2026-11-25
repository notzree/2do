import { Buffer } from "node:buffer";
import { eq } from "drizzle-orm";
import { imageId, imageMimeTypes } from "../interfaces/images.ts";
import type { PlannerStore } from "./planner.ts";
import { images } from "./schema.ts";

export function ownsImage(db: PlannerStore, id: string) {
  return !!db.select({ id: images.id }).from(images).where(eq(images.id, id)).get();
}

export class PlannerImages {
  constructor(
    private readonly db: PlannerStore,
    private readonly bucket: R2Bucket,
    private readonly owner: string,
  ) {}

  async save(bytes: Uint8Array<ArrayBuffer>, contentType: string) {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const id = Buffer.from(hash).toString("hex");
    await this.bucket.put(this.owner + "/" + id, bytes, { httpMetadata: { contentType } });
    this.db.insert(images).values({ id }).onConflictDoNothing().run();
    return { id };
  }

  read(id: string) {
    return this.bucket.get(this.owner + "/" + imageId.parse(id));
  }

  async dataUrl(id: string) {
    const object = await this.read(id);
    const mime = imageMimeTypes.find((type) => type === object?.httpMetadata?.contentType);
    if (!object || !mime) throw new Error("Image unavailable");
    return "data:" + mime + ";base64," + Buffer.from(await object.arrayBuffer()).toString("base64");
  }
}
