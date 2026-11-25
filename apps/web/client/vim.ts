import { useEffect, useEffectEvent } from "react";
import { boundCommand, type Bindings, type Command } from "./preferences.ts";
import { isTaskInspectorShortcut, toggleTaskHints } from "./commands.ts";
import { focusTaskTitle, stepNotebookSurface } from "./editor-navigation.ts";

export const shortcuts = [
	["Esc / i / a", "Normal mode / insert / append in the editor"],
	["j / k", "Next / previous block, across day boundaries"],
	["h l / w b / 0 $", "Character, word, and line motions"],
	["o / O", "Open a line below / above the current block"],
	["J / K", "Move the current block down / up"],
	["dd", "Delete the block. On a task, delete the task and all its notebook references."],
	["u / Ctrl-r", "Undo / redo notebook edits"],
	["/", "Inline commands · Space, Tab or Enter to complete"],
	["Ctrl-n / Ctrl-p", "Next / previous suggestion (also ↓ / ↑)"],
	["z", "Focus the current day or return to Week in Normal mode"],
	["h / l", "Fold / unfold subtasks"],
	["gg / G", "First / last visible task"],
	["o", "Add a task to the focused day"],
	["i / Enter", "Edit or open the focused task"],
	["Ctrl+]", "Open the focused task in the inspector"],
	["x", "Toggle completion"],
	["e", "Show or hide optional details on the focused task"],
	["[ / ]", "Previous / next period"],
	["h j k l", "Move left, down, up, right in the calendar grid"],
	["Esc", "Leave an input or close a dialog"],
	["?", "Open keybind settings"],
];
type Options = {
	enabled: boolean;
	bindings: Bindings;
	selectedDay: string;
	deleteTask: (id: string) => void;
	command: (id: Command) => void;
	shift: (amount: number) => void;
	help: () => void;
	calendarDay: (key: string, offset: number) => void;
};
type KeyPrefix = false | "g" | { deleteId: string };
export function usePlannerKeys(options: Options) {
	const dispatch = useEffectEvent((event: KeyboardEvent, prefix: KeyPrefix): KeyPrefix => {
		const target = event.target;
		if (
			!(target instanceof HTMLElement) ||
			event.defaultPrevented ||
			event.metaKey ||
			event.altKey ||
			event.isComposing
		)
			return false;
		if (
			document.querySelector("dialog[open]") ||
			target.closest(".graph, .copilot, .task-inspector, .review-panel")
		)
			return false;
		if (event.ctrlKey) {
			if (!options.enabled || !isTaskInspectorShortcut(event)) return false;
			if (!target.matches('button, input[type="checkbox"]')) return false;
			const title = target.matches("[data-task]")
				? target
				: target.closest(".task-row, .embedded.taskRef")?.querySelector<HTMLButtonElement>("[data-task]");
			if (title) {
				event.preventDefault();
				if (!event.repeat) title.click();
			}
			return false;
		}
		if (
			options.enabled &&
			event.key === "d" &&
			prefix !== "g" &&
			target.matches('[data-task], input[type="checkbox"]')
		) {
			const title = target
				.closest(".task-row, .embedded.taskRef")
				?.querySelector<HTMLElement>("[data-task]");
			const id = title?.dataset.task;
			if (title && id) {
				event.preventDefault();
				if (event.repeat) return false;
				if (!prefix || prefix.deleteId !== id) return { deleteId: id };
				if (title.closest(".ProseMirror")) focusTaskTitle(title);
				else if (!stepNotebookSurface(title, 1)) stepNotebookSurface(title, -1);
				options.deleteTask(id);
				return false;
			}
		}
		if (target.closest(".writing-surface")) {
			// Native node-view controls receive their own key events. Return to
			// the actual editor selection when navigating from a task button.
			const title = target.closest(".embedded.taskRef")?.querySelector<HTMLElement>("[data-task]");
			if (
				options.enabled &&
				title &&
				target.matches('button, input[type="checkbox"]') &&
				(event.key === "Escape" || event.key === "j" || event.key === "k")
			) {
				event.preventDefault();
				focusTaskTitle(title, event.key === "Escape" ? undefined : event.key === "j" ? 1 : -1);
			}
			return false;
		}
		if (target.closest("input:not([type=checkbox]), textarea, select, [contenteditable=true]")) {
			if (event.key === "Escape") {
				event.preventDefault();
				(
					target
						.closest(".agenda")
						?.querySelector<HTMLButtonElement>("[data-task]:not(details:not([open]) *)") ??
					document.querySelector<HTMLElement>("main")
				)?.focus();
			}
			return false;
		}
		if (!options.enabled) return false;
		const rows = Array.from(document.querySelectorAll<HTMLButtonElement>(".paper [data-task]")).filter(
			(el) => !el.closest("details:not([open])") && el.getClientRects().length,
		);
		const current = target.closest(".task-row");
		const row = current?.querySelector<HTMLButtonElement>("[data-task]");
		const index = row ? rows.indexOf(row) : -1;
		const focus = (i: number) => {
			const title = rows[Math.max(0, Math.min(i, rows.length - 1))];
			if (title) focusTaskTitle(title);
		};
		if (prefix === "g") {
			if (event.key === "g") focus(0);
			else {
				const command = boundCommand(options.bindings, event.key);
				if (!command) return false;
				options.command(command);
			}
		} else {
			const cell = target.closest<HTMLElement>("[data-calendar-day]");
			const offsets: Record<string, number> = { h: -1, j: 7, k: -7, l: 1 };
			if (cell && event.key in offsets)
				options.calendarDay(cell.dataset.calendarDay!, offsets[event.key]);
			else
				switch (event.key) {
					case "g":
						event.preventDefault();
						return "g";
					case "G":
						focus(rows.length - 1);
						break;
					case "j":
					case "k":
						if (row) stepNotebookSurface(row, event.key === "j" ? 1 : -1);
						else focus(event.key === "j" ? 0 : rows.length - 1);
						break;
					case "h":
					case "l": {
						const fold = current?.querySelector<HTMLButtonElement>(".fold");
						if (fold && fold.getAttribute("aria-expanded") === String(event.key === "h"))
							fold.click();
						else if (event.key === "h")
							current
								?.closest("ul")
								?.parentElement?.closest("li")
								?.querySelector<HTMLButtonElement>("[data-task]")
								?.focus();
						else if (fold) focus(index + 1);
						break;
					}
					case "o": {
						const agenda = target.closest(".agenda") ?? document.querySelector(".agenda");
						const day =
							target.closest(".day-sheet") ?? document.getElementById("day-" + options.selectedDay);
						const writing = day?.querySelector<HTMLElement>(".ProseMirror");
						if (writing) {
							writing.dispatchEvent(new Event("notebook-write"));
							break;
						}
						const input = agenda?.querySelector<HTMLInputElement>("[data-quick-add]");
						if (input) input.focus();
						else agenda?.querySelector<HTMLButtonElement>("[data-add-day]")?.click();
						break;
					}
					case "i":
						if (!row) return false;
						row.click();
						requestAnimationFrame(() => {
							const input = document.querySelector<HTMLInputElement>("[data-edit-title]");
							const details = input?.closest("details");
							if (details) details.open = true;
							input?.focus();
						});
						break;
					case "x":
						if (!current || event.repeat) return false;
						current.querySelector<HTMLInputElement>("input[type=checkbox]")?.click();
						break;
					case "e":
						if (event.repeat || !toggleTaskHints(current)) return false;
						break;
					case "[":
						options.shift(-1);
						break;
					case "]":
						options.shift(1);
						break;
					case "?":
						options.help();
						break;
					default:
						return false;
				}
		}
		event.preventDefault();
		return false;
	});
	useEffect(() => {
		let until = 0;
		let prefix: KeyPrefix = false;
		const reset = () => {
			prefix = false;
		};
		const handler = (event: KeyboardEvent) => {
			prefix = dispatch(event, performance.now() < until && prefix);
			until = performance.now() + 1000;
		};
		window.addEventListener("keydown", handler);
		window.addEventListener("blur", reset);
		document.addEventListener("focusin", reset);
		return () => {
			window.removeEventListener("keydown", handler);
			window.removeEventListener("blur", reset);
			document.removeEventListener("focusin", reset);
		};
	}, []);
}
