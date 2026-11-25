import { z } from "zod";
import { taskId } from "./plan.ts";
import { subtypeId } from "./task-plugins.ts";
import { imageId } from "./images.ts";
export { imageId, imageReceipt, imageMimeTypes, maxImageBytes } from "./images.ts";

/** Optimistic owner precondition for a browser replaying a locally saved draft. */
export const plannerScopeHeader = "X-Planner-Scope";

const text = z.strictObject({
	type: z.literal("text"),
	text: z.string().min(1),
	marks: z
		.array(z.strictObject({ type: z.enum(["strong", "em", "underline"]) }))
		.max(3)
		.optional(),
});
const prose = z.strictObject({
	type: z.enum(["paragraph", "heading"]),
	content: z.array(text).optional(),
});
const reference = z.strictObject({
	type: z.enum(["taskRef", "graphRef"]),
	attrs: z.strictObject({ id: taskId }),
});
const image = z.strictObject({
	type: z.literal("image"),
	attrs: z.strictObject({ id: imageId, alt: z.string().max(240) }),
});
export const notebookDoc = z.strictObject({
	type: z.literal("doc"),
	content: z
		.array(z.union([prose, reference, image]))
		.min(1)
		.max(5000),
});
export const dayPage = z.strictObject({
	version: z.literal(1),
	revision: z.int().nonnegative(),
	doc: notebookDoc,
});
export const maxRawInputLength = 4000;
const rawInput = z
	.string()
	.max(maxRawInputLength)
	.regex(/\S/)
	.describe("Verbatim task body after the slash command.");
const captureContext = {
	captureDate: z.iso
		.date()
		.optional()
		.describe("Local calendar date when the user entered the task."),
	timeZone: z
		.string()
		.min(1)
		.max(100)
		.refine((zone) => {
			try {
				new Intl.DateTimeFormat("en", { timeZone: zone });
				return true;
			} catch {
				return false;
			}
		}, "Unknown time zone")
		.optional(),
};
export const taskCapture = z.strictObject({
	rawInput,
	notebookDate: z.iso.date(),
	...captureContext,
});
export type TaskCapture = z.infer<typeof taskCapture>;
export const newTask = z
	.strictObject({
		id: taskId,
		title: z.string().trim().min(1).max(240),
		rawInput: rawInput.optional(),
		typeId: subtypeId.optional().describe("Explicitly attach an enabled subtype with a capture command."),
		...captureContext,
	})
	.refine(
		(item) =>
			item.rawInput !== undefined ||
			(item.captureDate === undefined && item.timeZone === undefined),
		"Capture context requires raw input.",
	);
export const writePage = dayPage.extend({ newTasks: z.array(newTask).max(500) });
export type DayPage = z.infer<typeof dayPage>;
export type NotebookDoc = DayPage["doc"];
export type WritePage = z.infer<typeof writePage>;
export type NewTask = z.infer<typeof newTask>;
export const deleteTaskReceipt = z.strictObject({
	pages: z.array(z.strictObject({
		date: z.iso.date(),
		previousRevision: z.int().nonnegative(),
		revision: z.int().positive(),
	})),
});
export type DeleteTaskReceipt = z.infer<typeof deleteTaskReceipt>;

export function withoutTaskReferences(doc: NotebookDoc, id: string): NotebookDoc {
	const content = doc.content.filter((node) =>
		(node.type !== "taskRef" && node.type !== "graphRef") || node.attrs.id !== id,
	);
	if (content.length === doc.content.length) return doc;
	return { ...doc, content: content.length ? content : [{ type: "paragraph" }] };
}

export const emptyPage = (): DayPage => ({
	version: 1,
	revision: 0,
	doc: { type: "doc", content: [{ type: "paragraph" }] },
});
