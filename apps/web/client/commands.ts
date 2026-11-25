import { createContext } from "react";
import { NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { lineStart } from "./editor-keys.ts";
import type { TaskPluginInstallation, TaskTypeIconName } from "@2do/api/task-plugins";
import type { Command } from "./preferences.ts";
import { nextPeriods, previousPeriods } from "./calendar.ts";

const periods = { ...nextPeriods, ...previousPeriods };
export type Period = keyof typeof periods;
export type SlashCommand = { description: string } & (
	| { kind: "draft"; name: "task" | "link task" | "graph" | "agent" | "side" }
	| { kind: "block"; name: "note" | "text" | "heading" | "image" }
	| { kind: "date"; name: string; period: Period }
	| { kind: "typed"; name: string; typeId: string; icon?: TaskTypeIconName }
);
const captureCommands: SlashCommand[] = [
	{ kind: "draft", name: "task", description: "Capture a task" },
	{ kind: "block", name: "note", description: "Write a note" },
];
const otherCommands: SlashCommand[] = [
	{ kind: "draft", name: "link task", description: "Reference a task" },
	{ kind: "draft", name: "graph", description: "Insert a task graph" },
	{ kind: "block", name: "heading", description: "Insert a heading" },
	{ kind: "block", name: "text", description: "Use a paragraph" },
	{ kind: "block", name: "image", description: "Attach an image" },
	{ kind: "draft", name: "agent", description: "Open main chat" },
	{ kind: "draft", name: "side", description: "Start a side chat" },
	...(Object.keys(periods) as Period[]).map((period) => ({
		kind: "date" as const,
		name: periods[period].toLowerCase(),
		description: "Navigate notebook",
		period,
	})),
];
export const commands = [...captureCommands, ...otherCommands];

export function notebookCommands(plugins: readonly TaskPluginInstallation[] = []): SlashCommand[] {
	const types = plugins.filter((p) => p.enabled).flatMap((p) => p.subtypes);
	const counts = new Map(commands.map((command) => [command.name.replaceAll(" ", "-"), 1]));
	for (const { captureCommand } of types) {
		if (captureCommand) counts.set(captureCommand, (counts.get(captureCommand) ?? 0) + 1);
	}
	const typed = types.flatMap(({ captureCommand, id, label, icon }) =>
		captureCommand
			? [
					{
						kind: "typed" as const,
						name: counts.get(captureCommand) === 1 ? captureCommand : id,
						typeId: id,
						description: "Create " + label.toLowerCase() + " task",
						icon,
					},
				]
			: [],
	);
	return [...captureCommands, ...typed, ...otherCommands];
}

export function isTaskInspectorShortcut(event: KeyboardEvent) {
	return event.ctrlKey && event.key === "]" && !event.altKey && !event.metaKey && !event.shiftKey;
}

export type TitleCaret = "start" | "end";

export function titleCaretForKey(key: string): TitleCaret | undefined {
	if (key === "i" || key === "I" || key === "Enter") return "start";
	if (key === "a" || key === "A") return "end";
}

// Address the visible occurrence, since one task can have multiple notebook references.
export function requestTitleEdit(button: HTMLElement, caret: TitleCaret) {
	button.dispatchEvent(new CustomEvent("edit-task-title", { detail: caret }));
}

export function editSelectedTaskTitle(view: EditorView, caret: TitleCaret) {
	const { selection } = view.state;
	if (!(selection instanceof NodeSelection) || selection.node.type.name !== "taskRef") return false;
	const row = view.nodeDOM(selection.from);
	const title = row instanceof Element && row.querySelector<HTMLElement>("button[data-task]");
	if (title) requestTitleEdit(title, caret);
	// A newly captured task may still be saving. Never let typing replace its reference.
	return true;
}

export function toggleTaskHints(row: Element | null) {
	const toggle = row?.querySelector<HTMLButtonElement>("button[data-task-enrich]:not(:disabled)");
	if (!toggle?.getClientRects().length) return false;
	toggle.click();
	return true;
}

export function toggleSelectedTaskHints(view: EditorView) {
	const pos = lineStart(view);
	if (view.state.doc.nodeAt(pos)?.type.name !== "taskRef") return false;
	const row = view.nodeDOM(pos);
	return row instanceof Element && toggleTaskHints(row);
}

/** Only task-level controls may close a panel; its fields keep their focus. */
export function toggleFocusedTaskHints(target: HTMLElement) {
	const row = target.closest(".task-row, .embedded.taskRef");
	if (!row) return false;
	const isTaskControl = target.matches("button[data-task], button[data-task-enrich]") ||
		(target.matches('input[type="checkbox"]') && target.parentElement === row);
	return isTaskControl && toggleTaskHints(row);
}

export const NotebookNavigation = createContext<{
	go: (command: Command) => void;
	help: () => void;
} | null>(null);
