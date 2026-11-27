import { z } from "zod";
import type { MetricObservation } from "./plugin-reports.ts";
import type { Task } from "./plan.ts";
import { imageId } from "./images.ts";

export type PluginData = Record<string, unknown>;
const key = z.string().regex(/^[a-z][a-zA-Z0-9]*$/);
export const actionId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const fieldBase = { key, label: z.string().min(1), required: z.boolean().optional() };
const actionField = z.discriminatedUnion("kind", [
  z.strictObject({ ...fieldBase, kind:z.literal("choice"),options:z.array(z.string().min(1)).min(1) }),
  z.strictObject({ ...fieldBase, kind: z.literal("date") }),
  z.strictObject({ ...fieldBase, kind: z.literal("number"), min: z.number().optional() }),
  z.strictObject({ ...fieldBase, kind: z.literal("text"), maxLength: z.int().positive() }),
  z.strictObject({ ...fieldBase, kind: z.literal("image") }),
]);
export const actionDefinition = z.strictObject({
  id: actionId,
  label: z.string().min(1),
  fields: z.array(actionField),
});
export type ActionDefinition = z.infer<typeof actionDefinition>;

export function actionInputSchema(definition: ActionDefinition) {
  const fields: Record<string, z.ZodType> = {};
  for (const field of definition.fields) {
    if (field.key in fields) throw new Error("Duplicate or reserved action field " + field.key);
    let schema: z.ZodType;
    switch (field.kind) {
      case "choice": schema=z.enum(field.options); break;
      case "date":
        schema = z.iso.date();
        break;
      case "number":
        schema = field.min === undefined ? z.number() : z.number().min(field.min);
        break;
      case "text":
        schema = z.string().trim().min(1).max(field.maxLength);
        break;
      case "image":
        schema = imageId;
        break;
    }
    fields[field.key] = field.required ? schema : schema.optional();
  }
  return z.strictObject(fields);
}

const revisions = {
  installationEpoch: z.uuid(),
  taskRevision: z.int().nonnegative(),
  subtypeRevision: z.uuid(),
  workflowRevision: z.uuid().nullable(),
};
export const workflowCommand = z.strictObject({
  ...revisions,
  commandId: z.uuid(),
  input: z.record(z.string(), z.unknown()),
});
export type WorkflowCommand = z.infer<typeof workflowCommand>;
export const workflowReceipt = z.strictObject({ commandId: z.uuid(), workflowRevision: z.uuid() });
export const workflowDetails = z.strictObject({
  ...revisions,
  typeId: z.string(),
  status: z.string(),
  properties: z.array(z.strictObject({ label: z.string(), value: z.string().nullable() })).optional(),
  pending: z.boolean(),
  actions: z.array(
    actionDefinition.extend({ defaults: z.record(z.string(), z.union([z.number(), z.string()])) }),
  ),
});
export type WorkflowDetails = z.infer<typeof workflowDetails>;

export interface WorkflowSnapshot<Data = PluginData> {
  task: Task;
  data: Data;
  revision: string;
  timeZone: string;
  today: string;
}
export type WorkflowEvent =
  | { kind: "changed" }
  | { kind: "resumed"; changedTaskFields: string[] }
  | { kind: "command"; id: string; input: PluginData }
  | { kind: "effect"; id: string; result: unknown; failed: boolean };
export interface WorkflowTransition<State> {
  state: State;
  /** An explicit user command accepts this subtype as part of the task. */
  confirmSubtype?: boolean;
  effect?: { id: string; input: PluginData };
}
export interface PluginWorkflow<Data = PluginData, State extends PluginData = PluginData> {
  version: number;
  schema: z.ZodType<State>;
  initial: State;
  commands: ActionDefinition[];
  /** Short status suitable for a collapsed task row. */
  summaryStatus?(state: State): string;
  migrations?: Record<number, (data: PluginData) => PluginData>;
  describe(
    current: WorkflowSnapshot<Data>,
    state: State,
    pending: boolean,
    effects: ReadonlySet<string>,
  ): {
    status: string;
    properties?: WorkflowDetails["properties"];
    actions: { id: string; label?: string; defaults?: Record<string, string | number> }[];
  };
  transition(
    previous: WorkflowSnapshot<Data> | undefined,
    current: WorkflowSnapshot<Data>,
    state: State,
    event: WorkflowEvent,
  ): WorkflowTransition<State>;
  measure(current: WorkflowSnapshot<Data>, state: State): MetricObservation[];
}
export type EffectHandler = (input: PluginData, signal: AbortSignal) => Promise<unknown>;
