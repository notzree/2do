import type { EditorView } from "@tiptap/pm/view";
import { selectLine } from "./editor-keys.ts";

export type EditorMode = "Insert" | "Normal";

export function bindNotebookEditorEvents(
	view: EditorView,
	setMode: (mode: EditorMode) => void,
) {
	const enter = (event: Event) => {
		const direction = (event as CustomEvent<1 | -1>).detail;
		if (direction !== 1 && direction !== -1) return;

		view.focus();
		setMode("Normal");
		const { doc } = view.state;
		selectLine(view, direction === 1 ? 0 : doc.content.size - doc.lastChild!.nodeSize);
	};
	const write = () => setMode("Insert");

	view.dom.addEventListener("notebook-enter", enter);
	view.dom.addEventListener("notebook-write", write);

	return () => {
		view.dom.removeEventListener("notebook-enter", enter);
		view.dom.removeEventListener("notebook-write", write);
	};
}
