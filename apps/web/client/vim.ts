import { useEffect, useEffectEvent } from "react";
import { boundCommand, type Bindings, type Command } from "./preferences.ts";

export const shortcuts = [
	["Esc / i / a", "Normal mode / insert / append in the editor"],
	["j / k", "Next / previous block, across day boundaries"],
	["h l / w b / 0 $", "Character, word, and line motions"],
	["o / O", "Open a line below / above the current block"],
	["J / K", "Move the current block down / up"],
	["dd / u / Ctrl-r", "Remove block / undo / redo"],
	["/", "Insert a task, task link, graph, heading or image"],
	["h / l", "Fold / unfold subtasks"],
	["gg / G", "First / last visible task"],
	["o", "Add a task to the focused day"],
	["i / Enter", "Edit or open the focused task"],
	["x", "Toggle completion"],
	["[ / ]", "Previous / next period"],
	["h j k l", "Move left, down, up, right in the calendar grid"],
	["Esc", "Leave an input or close a dialog"],
	["?", "Open keybind settings"],
];
type Options = {
	enabled: boolean;
	bindings: Bindings;
	command: (id: Command) => void;
	shift: (amount: number) => void;
	help: () => void;
	calendarDay: (key: string, offset: number) => void;
};
export function usePlannerKeys(options: Options) {
	const dispatch = useEffectEvent((event: KeyboardEvent, prefix: boolean) => {
		const target = event.target;
		if (
			!(target instanceof HTMLElement) ||
			event.defaultPrevented ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			event.isComposing
		)
			return false;
		if (document.querySelector("dialog[open]") || target.closest(".writing-surface, .graph, .copilot")) return false;
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
		const rows = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-task]")).filter(
			(el) => !el.closest("details:not([open])") && el.getClientRects().length,
		);
		const current = target.closest(".task-row");
		const row = current?.querySelector<HTMLButtonElement>("[data-task]");
		const index = row ? rows.indexOf(row) : -1;
		const focus = (i: number) => rows[Math.max(0, Math.min(i, rows.length - 1))]?.focus();
		if (prefix) {
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
						return true;
					case "G":
						focus(rows.length - 1);
						break;
					case "j":
						focus(index + 1);
						break;
					case "k":
						focus(index < 0 ? rows.length - 1 : index - 1);
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
						const writing = document.querySelector<HTMLElement>(".ProseMirror");
						if(writing){writing.focus();writing.dispatchEvent(new Event("notebook-write"));break;}
						const input = agenda?.querySelector<HTMLInputElement>("[data-quick-add]");
						if (input) input.focus();
						else agenda?.querySelector<HTMLButtonElement>("[data-add-day]")?.click();
						break;
					}
					case "i":
						if (!row) return false;
						row.click();
						requestAnimationFrame(() =>
							document.querySelector<HTMLInputElement>("[data-edit-title]")?.focus(),
						);
						break;
					case "x":
						if (!current || event.repeat) return false;
						current.querySelector<HTMLInputElement>("input[type=checkbox]")?.click();
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
		const reset = () => {
			until = 0;
		};
		const handler = (event: KeyboardEvent) => {
			until = dispatch(event, performance.now() < until) ? performance.now() + 1000 : 0;
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
