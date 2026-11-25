import type { EditorView } from "@tiptap/pm/view";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import { VimMode } from "@prose-motions/core";
import { deleteCurrentBlock, selectLine, stepLine } from "./editor-keys.ts";

export type EditorMode = "Insert" | "Normal";

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		notebookBlocks: {
			deleteNotebookBlock: () => ReturnType;
		};
	}
}

// Back up within the current textblock on Escape. At its start, the previous
// document position is a block boundary and cannot hold a text cursor.
export function normalSelection(selection: Selection) {
	if (selection instanceof NodeSelection) return selection;
	const { $head } = selection;
	if (!$head.parent.inlineContent) return Selection.near($head);
	return TextSelection.create($head.doc, $head.pos - Math.min(1, $head.parentOffset));
}

export const NotebookVim = VimMode.extend<{ deleteTask?: (id: string) => void }>({
	addOptions() {
		return {};
	},
	addKeyboardShortcuts() {
		const move = (direction: 1 | -1) => {
			if (this.storage.state.mode !== "normal") return false;
			moveNotebookCursor(this.editor.view, direction);
			return true;
		};
		return { ...this.parent?.(), j: () => move(1), k: () => move(-1) };
	},
	addCommands() {
		return {
			...this.parent?.(),
			deleteNotebookBlock:
				() =>
				({ tr, dispatch }) =>
					dispatch ? deleteCurrentBlock(tr, this.options.deleteTask) : true,
			enterNormalMode:
				() =>
				({ tr, dispatch }) => {
					if (dispatch && this.storage.state.mode !== "normal") {
						this.storage.state.mode = "normal";
						tr.setSelection(normalSelection(tr.selection));
					}
					return true;
				},
		};
	},
});

export function moveNotebookCursor(view: EditorView, direction: 1 | -1) {
	if (stepLine(view, direction)) return;
	stepNotebookSurface(view.dom, direction);
}

// Day editors and scheduled rows are siblings in the rendered notebook.
// Both entry points must traverse the same stops in the same order.
export function stepNotebookSurface(current: HTMLElement, direction: 1 | -1) {
	const stops = Array.from(
		current.closest("main")?.querySelectorAll<HTMLElement>(".ProseMirror, .task-row [data-task]") ??
			[],
	).filter((el) => el.getClientRects().length);
	const index = stops.indexOf(current);
	const next = index >= 0 ? stops[index + direction] : undefined;
	if (!next) return false;
	if (next.matches(".ProseMirror")) {
		next.dispatchEvent(new CustomEvent("notebook-enter", { detail: direction }));
	} else {
		next.focus({ preventScroll: true });
		next.scrollIntoView({ block: "nearest", inline: "nearest" });
	}
	return true;
}

export function focusTaskTitle(title: HTMLElement, direction?: 1 | -1) {
	if (title.closest(".embedded.taskRef")) {
		title.dispatchEvent(
			new CustomEvent("notebook-select-task", { bubbles: true, detail: direction }),
		);
	} else {
		title.focus({ preventScroll: true });
		title.scrollIntoView({ block: "nearest", inline: "nearest" });
	}
}

export function bindNotebookEditorEvents(view: EditorView, setMode: (mode: EditorMode) => void) {
	const enter = (event: Event) => {
		const direction = (event as CustomEvent<1 | -1>).detail;
		if (direction !== 1 && direction !== -1) return;

		view.focus();
		setMode("Normal");
		const { doc } = view.state;
		selectLine(view, direction === 1 ? 0 : doc.content.size - doc.lastChild!.nodeSize);
	};
	const write = (event: Event) => {
		const { state } = view;
		const last = state.doc.lastChild;
		const tr = state.tr;
		if (last?.type.name !== "paragraph" || last.content.size)
			tr.insert(state.doc.content.size, state.schema.nodes.paragraph.create());
		tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
		if (event.type === "notebook-task") tr.insertText("/task ");
		view.dispatch(tr.scrollIntoView());
		setMode("Insert");
		view.focus();
	};
	const selectTask = (event: Event) => {
		if (!(event.target instanceof Element)) return;
		const row = event.target.closest(".embedded.taskRef");
		if (!row) return;
		const pos = view.posAtDOM(row, 0, -1);
		if (view.state.doc.nodeAt(pos)?.type.name !== "taskRef") return;
		setMode("Normal");
		selectLine(view, pos);
		view.focus();
		const direction = (event as CustomEvent).detail;
		if (direction === 1 || direction === -1) moveNotebookCursor(view, direction);
	};
	// Focusing the contenteditable directly lets the browser place its text
	// caret next to a non-editable atom, dropping the editor's NodeSelection.
	const refocus = () => view.focus();

	view.dom.addEventListener("notebook-enter", enter);
	view.dom.addEventListener("notebook-select-task", selectTask);
	view.dom.addEventListener("notebook-refocus", refocus);
	view.dom.addEventListener("notebook-write", write);
	view.dom.addEventListener("notebook-task", write);

	return () => {
		view.dom.removeEventListener("notebook-enter", enter);
		view.dom.removeEventListener("notebook-select-task", selectTask);
		view.dom.removeEventListener("notebook-refocus", refocus);
		view.dom.removeEventListener("notebook-write", write);
		view.dom.removeEventListener("notebook-task", write);
	};
}
