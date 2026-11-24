import { z } from "zod";
import { taskId } from "./plan.ts";

const text = z.strictObject({
	type: z.literal("text"), text: z.string().min(1),
	marks: z.array(z.strictObject({ type: z.enum(["strong", "em", "underline"]) })).max(3).optional(),
});
const prose = z.strictObject({type: z.enum(["paragraph", "heading"]), content: z.array(text).optional()});
const reference = z.strictObject({type: z.enum(["taskRef","graphRef"]), attrs: z.strictObject({id: taskId})});
export const imageId = z.string().regex(/^[a-f0-9]{64}$/);
const image = z.strictObject({type: z.literal("image"), attrs: z.strictObject({id: imageId, alt: z.string().max(240)})});
export const notebookDoc = z.strictObject({type:z.literal("doc"), content:z.array(z.union([prose,reference,image])).min(1).max(5000)});
export const dayPage = z.strictObject({version:z.literal(1),revision:z.int().nonnegative(),doc:notebookDoc});
export const newTask = z.strictObject({id:taskId,title:z.string().trim().min(1).max(240)});
export const writePage = dayPage.extend({newTasks:z.array(newTask).max(500)});
export type DayPage = z.infer<typeof dayPage>;
export type NotebookDoc = DayPage["doc"];
export type NewTask = z.infer<typeof newTask>;
export const emptyPage = (): DayPage => ({version:1,revision:0,doc:{type:"doc",content:[{type:"paragraph"}]}});
