import { expect, it, vi } from "vite-plus/test";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { editorExtensions } from "./editor-extensions.ts";
import { bindNotebookEditorEvents } from "./editor-navigation.ts";

it("enters the adjacent day's editor in Normal mode at its first or last line", () => {
	const schema = getSchema(editorExtensions(() => {}));
	const doc = schema.nodeFromJSON({
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "first day" }] },
			{ type: "paragraph", content: [{ type: "text", text: "next day" }] },
		],
	});
	let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 2) });
	const dom = new EventTarget();
	const focus = vi.fn();
	const view = {
		dom,
		get state() {
			return state;
		},
		focus,
		dispatch(transaction: Parameters<EditorView["dispatch"]>[0]) {
			state = state.apply(transaction);
		},
	} as unknown as EditorView;
	const modes: string[] = [];
	const unbind = bindNotebookEditorEvents(view, (mode) => modes.push(mode));

	dom.dispatchEvent(new CustomEvent("notebook-enter", { detail: 1 }));
	expect(focus).toHaveBeenCalledTimes(1);
	expect(modes).toEqual(["Normal"]);
	expect(state.selection.from).toBe(1);

	dom.dispatchEvent(new CustomEvent("notebook-enter", { detail: -1 }));
	expect(focus).toHaveBeenCalledTimes(2);
	expect(modes).toEqual(["Normal", "Normal"]);
	expect(state.selection.from).toBe(doc.content.size - doc.lastChild!.nodeSize + 1);

	dom.dispatchEvent(new Event("notebook-write"));
	expect(modes.at(-1)).toBe("Insert");

	unbind();
});
