import { z } from "zod";
import { timeZone } from "./plan.ts";

const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const minutes = z.int().min(0).max(43200);
export const reminderTrigger = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("at"), at: z.iso.datetime({ offset: true }) }),
  z.strictObject({ kind: z.literal("before"), anchor: z.enum(["start", "due"]), minutes }),
  z.strictObject({ kind: z.literal("due-tasks"), minutes }),
  z.strictObject({
    kind: z.literal("routine"),
    time: localTime,
    instruction: z.string().trim().min(1).max(2000),
  }),
  z.strictObject({
    kind: z.literal("daily"),
    time: localTime,
    summary: z.enum(["agenda", "blocked"]),
    synthesize: z.boolean().optional(),
  }),
]);
export type ReminderTrigger = z.infer<typeof reminderTrigger>;
export const reminderInput = z
  .strictObject({
    title: z.string().trim().min(1).max(240),
    taskId: z.uuid().optional(),
    trigger: reminderTrigger,
    enabled: z.boolean(),
  })
  .refine(
    (rule) =>
      rule.trigger.kind === "before" ? !!rule.taskId : rule.trigger.kind === "at" || !rule.taskId,
    "Choose one task for relative reminders and no task for a planner-wide rule.",
  );
export type ReminderInput = z.infer<typeof reminderInput>;
export const reminderRule = reminderInput.safeExtend({
  id: z.uuid(),
  nextAt: z.number().nullable(),
});
export type ReminderRule = z.infer<typeof reminderRule>;
export const reminderSettings = z
  .strictObject({
    timeZone,
    paused: z.boolean(),
    dayTime: localTime,
    quietStart: localTime.nullable(),
    quietEnd: localTime.nullable(),
  })
  .refine(
    (s) =>
      (s.quietStart === null && s.quietEnd === null) ||
      (s.quietStart !== null && s.quietEnd !== null && s.quietStart !== s.quietEnd),
    "Set both quiet-hour times and choose a different start and end.",
  );
export type ReminderSettings = z.infer<typeof reminderSettings>;
export const remindersResponse = z.object({
  settings: reminderSettings,
  rules: z.array(reminderRule),
  pushPublicKey: z.string().nullable(),
});

function allowedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    return (
      url.hostname === "fcm.googleapis.com" ||
      url.hostname === "updates.push.services.mozilla.com" ||
      url.hostname.endsWith(".push.services.mozilla.com") ||
      url.hostname === "web.push.apple.com" ||
      url.hostname.endsWith(".notify.windows.com")
    );
  } catch {
    return false;
  }
}
export const reminderSubscription = z.strictObject({
  endpoint: z.string().max(4096).refine(allowedPushEndpoint, "Unsupported browser push service."),
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: z.string().regex(/^B[A-Za-z0-9_-]{86}=?$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}(?:==)?$/),
  }),
});
export type ReminderSubscription = z.infer<typeof reminderSubscription>;
