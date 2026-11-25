import { expect, it, vi } from "vite-plus/test";
import { getSchema } from "@tiptap/core";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { editorExtensions } from "./editor-extensions.ts";
import {
	bindNotebookEditorEvents,
	NotebookVim,
	normalSelection,
	stepNotebookSurface,
} from "./editor-navigation.ts";
import { deleteCurrentBlock, removeDeletedTask, stepLine } from "./editor-keys.ts";

function mockView(doc: Node, cursor: number) {
	let state = EditorState.create({ doc, selection: TextSelection.create(doc, cursor) });
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
	return { view, dom, focus };
}

const schema = getSchema(editorExtensions());

it("enters the adjacent day's editor in Normal mode at its first or last line", () => {
	const doc = schema.nodeFromJSON({
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "first day" }] },
			{ type: "paragraph", content: [{ type: "text", text: "next day" }] },
		],
	});
	const { view, dom, focus } = mockView(doc, 2);
	const modes: string[] = [];
	const unbind = bindNotebookEditorEvents(view, (mode) => modes.push(mode));

	dom.dispatchEvent(new CustomEvent("notebook-enter", { detail: 1 }));
	expect(focus).toHaveBeenCalledTimes(1);
	expect(modes).toEqual(["Normal"]);
	expect(view.state.selection.from).toBe(1);

	dom.dispatchEvent(new CustomEvent("notebook-enter", { detail: -1 }));
	expect(focus).toHaveBeenCalledTimes(2);
	expect(modes).toEqual(["Normal", "Normal"]);
	expect(view.state.selection.from).toBe(doc.content.size - doc.lastChild!.nodeSize + 1);

	dom.dispatchEvent(new Event("notebook-write"));
	expect(modes.at(-1)).toBe("Insert");
	expect(view.state.doc.childCount).toBe(3);
	expect(view.state.selection.from).toBe(view.state.doc.content.size - 1);
	dom.dispatchEvent(new Event("notebook-write"));
	expect(view.state.doc.childCount).toBe(3);

	unbind();
});

it("enters Normal in the blank capture line and selects adjacent task references in both directions", () => {
	const first = schema.node("taskRef", { id: crypto.randomUUID() });
	const second = schema.node("taskRef", { id: crypto.randomUUID() });
	const doc = schema.node("doc", null, [first, second, schema.node("paragraph")]);
	const { view } = mockView(doc, doc.content.size - 1);
	const caret = normalSelection(view.state.selection);
	expect(caret.$head.parent.type.name).toBe("paragraph");
	view.dispatch(view.state.tr.setSelection(caret));
	for (const [direction, expected] of [
		[-1, second],
		[-1, first],
		[1, second],
	] as const) {
		expect(stepLine(view, direction)).toBe(true);
		const selection = view.state.selection;
		expect(selection).toBeInstanceOf(NodeSelection);
		expect((selection as NodeSelection).node.attrs.id).toBe(expected.attrs.id);
		expect(normalSelection(selection)).toBe(selection);
	}
	expect(stepLine(view, 1)).toBe(true);
	expect(view.state.selection.eq(caret)).toBe(true);
});

it("backs up one character inside a text block and leaves its first position valid", () => {
	const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("note")])]);
	expect(normalSelection(TextSelection.create(doc, 4)).from).toBe(3);
	expect(normalSelection(TextSelection.create(doc, 1)).from).toBe(1);
});

it("continues upwards through a standalone row into the preceding editor, then back down", () => {
	const stops = [true, false, true].map((editor) => ({
		getClientRects: () => [{ height: 20 }],
		matches: () => editor,
		focus: vi.fn(),
		scrollIntoView: vi.fn(),
		dispatchEvent: vi.fn(),
		closest: () => ({ querySelectorAll: () => stops }),
	}));
	const [before, scheduled, after] = stops;
	const step = (index: number, dir: 1 | -1) =>
		stepNotebookSurface(stops[index] as unknown as HTMLElement, dir);
	expect(step(2, -1)).toBe(true);
	expect(scheduled.focus).toHaveBeenCalledOnce();
	expect(step(1, -1)).toBe(true);
	expect(before.dispatchEvent).toHaveBeenCalledWith(
		expect.objectContaining({ type: "notebook-enter", detail: -1 }),
	);
	expect(step(0, -1)).toBe(false);
	expect(step(0, 1)).toBe(true);
	expect(scheduled.focus).toHaveBeenCalledTimes(2);
	expect(step(1, 1)).toBe(true);
	expect(after.dispatchEvent).toHaveBeenCalledWith(
		expect.objectContaining({ type: "notebook-enter", detail: 1 }),
	);
});

it("dd on a task requests a planner deletion. Its receipt removes only references to that ID", () => {
	const id = crypto.randomUUID();
	const ref = schema.node("taskRef", { id });
	const other = schema.node("taskRef", { id: crypto.randomUUID() });
	const note = schema.node("paragraph", null, [schema.text("Keep writing")]);
	const doc = schema.node("doc", null, [ref, ref, schema.node("graphRef", { id }), other, note]);
	const { view } = mockView(doc, doc.content.size - 1);
	view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, 0)));
	const tr = view.state.tr;
	const remove = vi.fn();
	const extension = NotebookVim.configure({ deleteTask: remove });
	expect(deleteCurrentBlock(tr, extension.options.deleteTask)).toBe(true);
	expect(remove).toHaveBeenCalledExactlyOnceWith(id);
	expect(tr.docChanged).toBe(false);
	removeDeletedTask(view, id);
	expect(view.state.doc.content.content).toEqual([other, note]);
	expect((view.state.selection as NodeSelection).node).toBe(other);
});

it("keeps dd on a graph a local block edit and preserves a text caret when task links disappear", () => {
	const id = crypto.randomUUID();
	const ref = schema.node("taskRef", { id });
	const graph = schema.node("graphRef", { id });
	const note = schema.node("paragraph", null, [schema.text("Keep writing")]);
	const doc = schema.node("doc", null, [graph, ref, note]);
	const { view } = mockView(doc, doc.content.size - 2);
	const remove = vi.fn();
	const tr = view.state.tr.setSelection(NodeSelection.create(doc, 0));
	expect(deleteCurrentBlock(tr, remove)).toBe(true);
	expect(remove).not.toHaveBeenCalled();
	expect(tr.doc.content.content).toEqual([ref, note]);
	const offset = view.state.selection.$from.parentOffset;
	removeDeletedTask(view, id);
	expect(view.state.selection.$from.parent).toBe(note);
	expect(view.state.selection.$from.parentOffset).toBe(offset);
});
