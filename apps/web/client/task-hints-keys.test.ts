import { expect, it, vi } from "vite-plus/test";
import { getSchema } from "@tiptap/core";
import { EditorState, NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { editorExtensions } from "./editor-extensions.ts";
import { toggleFocusedTaskHints, toggleSelectedTaskHints, toggleTaskHints } from "./commands.ts";

it("routes a selected notebook task to its own details control, not a graph", () => {
	const schema = getSchema(editorExtensions());
	const doc = schema.nodeFromJSON({
		type: "doc",
		content: [
			{ type: "taskRef", attrs: { id: "first" } },
			{ type: "graphRef", attrs: { id: "second" } },
		],
	});
	const click = vi.fn();
	class Row {
		querySelector() { return { getClientRects: () => [1], click }; }
	}
	vi.stubGlobal("Element", Row);
	try {
		const view = {
			state: EditorState.create({ schema, doc, selection: NodeSelection.create(doc, 0) }),
			nodeDOM: () => new Row(),
		} as unknown as EditorView;
		expect(toggleSelectedTaskHints(view)).toBe(true);
		expect(click).toHaveBeenCalledOnce();
		Object.assign(view, { state: EditorState.create({ schema, doc, selection: NodeSelection.create(doc, 1) }) });
		expect(toggleSelectedTaskHints(view)).toBe(false);
		expect(click).toHaveBeenCalledOnce();
	} finally {
		vi.unstubAllGlobals();
	}
});

it("uses the focused task's control and leaves detail fields alone", () => {
	const click = vi.fn();
	const row = { querySelector: () => ({ getClientRects: () => [1], click }) } as unknown as Element;
	const target = (isControl: boolean) => ({
		matches: (selector: string) => isControl && selector.startsWith("button"),
		closest: () => row,
	}) as unknown as HTMLElement;
	expect(toggleFocusedTaskHints(target(true))).toBe(true);
	expect(click).toHaveBeenCalledOnce();
	expect(toggleFocusedTaskHints(target(false))).toBe(false);
	expect(click).toHaveBeenCalledOnce();
	expect(toggleTaskHints(null)).toBe(false);
});
