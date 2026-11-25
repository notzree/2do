import { expect, it, vi } from "vite-plus/test";
import { getSchema } from "@tiptap/core";
import { EditorState, NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { editorExtensions } from "./editor-extensions.ts";
import {
	editSelectedTaskTitle, titleCaretForKey, toggleFocusedTaskHints, toggleSelectedTaskHints, toggleTaskHints,
} from "./commands.ts";

it("routes insert and append to the selected task title, including while its capture is saving", () => {
	const schema = getSchema(editorExtensions());
	const doc = schema.node("doc", null, [schema.node("taskRef", { id: "selected" })]);
	const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 0) });
	const button = new EventTarget();
	const positions: string[] = [];
	button.addEventListener("edit-task-title", (event) => positions.push((event as CustomEvent).detail));
	class Row {
		title: EventTarget | null = button;
		querySelector() { return this.title; }
	}
	const row = new Row();
	vi.stubGlobal("Element", Row);
	try {
		const view = { state, nodeDOM: () => row } as unknown as EditorView;
		for (const key of ["i", "I", "a", "A", "Enter"]) {
			expect(editSelectedTaskTitle(view, titleCaretForKey(key)!)).toBe(true);
		}
		expect(positions).toEqual(["start", "start", "end", "end", "start"]);
		row.title = null;
		expect(editSelectedTaskTitle(view, "start")).toBe(true);
		expect(state.doc).toBe(doc);
		expect(positions).toHaveLength(5);
	} finally {
		vi.unstubAllGlobals();
	}
});

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
