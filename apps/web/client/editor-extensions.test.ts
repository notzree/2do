import { expect, it } from "vite-plus/test";
import { getSchema } from "@tiptap/core";
import { notebookDoc } from "@2do/api/notebook";
import { editorExtensions } from "./editor-extensions.ts";

it("round-trips saved notebook content through the Tiptap schema", () => {
	const saved = notebookDoc.parse({
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "Plan", marks: [{ type: "strong" }] }] },
			{ type: "heading", content: [{ type: "text", text: "Notes" }] },
			{ type: "taskRef", attrs: { id: crypto.randomUUID() } },
			{ type: "graphRef", attrs: { id: crypto.randomUUID() } },
			{ type: "image", attrs: { id: "a".repeat(64), alt: "sketch" } },
		],
	});
	const schema = getSchema(editorExtensions(() => {}));

	expect(notebookDoc.parse(schema.nodeFromJSON(saved).toJSON())).toEqual(saved);
});
