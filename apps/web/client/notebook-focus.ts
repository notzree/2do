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
