import { z } from "zod";

const field = z.strictObject({
  name: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  type: z.enum(["string", "boolean", "number", "integer"]),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.int().nonnegative().optional(),
  maxLength: z.int().nonnegative().optional(),
});
const display = { provider: z.string(), message: z.string().min(1).max(2000) };
export const elicitationView = z.discriminatedUnion("mode", [
  z.strictObject({ ...display, mode: z.literal("form"), fields: z.array(field).min(1).max(12) }),
  z.strictObject({ ...display, mode: z.literal("url"), url: z.url(), host: z.string() }),
]);
export const elicitationReply = z.strictObject({
  action: z.enum(["accept", "decline", "cancel"]),
  values: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
});
export type ElicitationView = z.infer<typeof elicitationView>;
export type ElicitationReply = z.infer<typeof elicitationReply>;
export interface McpContinuation {
  workflow: string;
  round: number;
  provider: string;
  tool: string;
  args: Record<string, unknown>;
  key: string;
  requestState?: string;
}

export function validateElicitationReply(
  view: ElicitationView,
  reply: ElicitationReply,
): ElicitationReply {
  if (reply.action !== "accept" || view.mode === "url") {
    if (reply.values && Object.keys(reply.values).length)
      throw new Error("This response does not accept form values.");
    return { action: reply.action };
  }
  const values = reply.values ?? {},
    result: NonNullable<ElicitationReply["values"]> = {};
  if (Object.keys(values).some((k) => !view.fields.some((f) => f.name === k)))
    throw new Error("Unknown form field.");
  for (const f of view.fields) {
    if (!Object.hasOwn(values, f.name)) {
      if (f.required) throw new Error("Enter " + f.label + ".");
      continue;
    }
    const v = values[f.name];
    const valid =
      f.type === "string"
        ? typeof v === "string" &&
          (!f.options || f.options.includes(v)) &&
          v.length >= (f.minLength ?? 0) &&
          v.length <= Math.min(f.maxLength ?? 2000, 2000)
        : f.type === "boolean"
          ? typeof v === "boolean"
          : typeof v === "number" &&
            Number.isFinite(v) &&
            (f.type !== "integer" || Number.isSafeInteger(v)) &&
            v >= (f.min ?? -Infinity) &&
            v <= (f.max ?? Infinity);
    if (!valid) throw new Error("Check " + f.label + ".");
    result[f.name] = v;
  }
  return { action: "accept", values: result };
}
