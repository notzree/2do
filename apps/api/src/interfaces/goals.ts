import { z } from "zod";

const name = z.string().trim().min(1).max(240);
const typeId = z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
export const goalField = z.discriminatedUnion("kind", [
  z.strictObject({
    key: z.string(),
    label: name,
    kind: z.literal("number"),
    min: z.number(),
    integer: z.boolean().optional(),
  }),
  z.strictObject({
    key: z.string(),
    label: name,
    kind: z.literal("choice"),
    options: z.array(name).min(1),
  }),
  z.strictObject({ key: z.string(), label: name, kind: z.literal("month") }),
]);
export const goalType = z.strictObject({
  id: typeId,
  label: name,
  version: z.int().positive(),
  fields: z.array(goalField),
});
export type GoalType = z.infer<typeof goalType>;
export const goalConfig = z.record(z.string(), z.union([z.string(), z.number()]));
export type GoalConfig = z.infer<typeof goalConfig>;
const attachment = z.strictObject({ typeId, version: z.int().positive(), data: goalConfig });
const dates = { targetDate: z.iso.date().nullable(), nextCheckIn: z.iso.date().nullable() };
export const goalRecord = z.strictObject({
  title: name,
  ...dates,
  manualAchievement: z.boolean(),
  subtype: attachment.nullable(),
  timeZone: z.string(),
  dailyMetric: z.string().nullable(),
});
export const newPlannerGoal = z.strictObject({
  id: z.uuid(),
  title: name,
  targetDate: dates.targetDate.optional(),
  nextCheckIn: dates.nextCheckIn.optional(),
  subtype: attachment.optional(),
});
export const linkRole = z.enum(["contributes", "satisfies"]);
export const goalChange = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("edit"),
    title: name,
    ...dates,
    subtype: attachment.nullable().optional(),
  }),
  z.strictObject({ action: z.literal("achievement"), achieved: z.boolean() }),
  z.strictObject({ action: z.literal("link"), taskId: z.uuid(), role: linkRole.nullable() }),
  z.strictObject({
    action: z.literal("check-in"),
    note: z.string().trim().min(1).max(2000),
    nextCheckIn: dates.nextCheckIn,
  }),
  z.strictObject({ action: z.literal("subtype"), subtype: attachment.nullable() }),
]);
export const editPlannerGoal = z.strictObject({ revision: z.uuid(), change: goalChange });
export const goalProgress = z.strictObject({ label: z.string(), satisfied: z.boolean() });
export const plannerGoal = goalRecord.extend({
  id: z.uuid(),
  revision: z.uuid(),
  achieved: z.boolean(),
  progress: goalProgress.nullable(),
  links: z.array(
    z.strictObject({ taskId: z.uuid(), title: name, completed: z.boolean(), role: linkRole }),
  ),
  checkIns: z.array(z.strictObject({ at: z.iso.datetime(), note: z.string() })),
});
export type PlannerGoal = z.infer<typeof plannerGoal>;
export type GoalRecord = z.infer<typeof goalRecord>;
export type GoalChange = z.infer<typeof goalChange>;
export type GoalObservation = {
  taskId: string;
  sourceKey: string;
  metricId: string;
  day: string;
  value: number | null;
};
/** Plugins receive confirmed observations for their own declared metrics in a half-open civil date range. */
export interface GoalSubtypeDefinition extends GoalType {
  metrics: string[];
  validate?(data: GoalConfig): void;
  period(data: GoalConfig, today: string): { from: string; to: string } | undefined;
  evaluate(data: GoalConfig, rows: GoalObservation[], today: string): z.infer<typeof goalProgress>;
}
export function validateGoalConfig(type: GoalType, data: GoalConfig) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of type.fields) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(f.key) || f.key in shape)
      throw new Error("Invalid goal field " + f.key);
    if (f.kind === "number") shape[f.key] = (f.integer ? z.int() : z.number()).min(f.min);
    if (f.kind === "choice") shape[f.key] = z.enum(f.options);
    if (f.kind === "month") shape[f.key] = z.string().regex(/^\d{4}-(0[1-9]|1[012])$/);
  }
  z.strictObject(shape).parse(data);
}
