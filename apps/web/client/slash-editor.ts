import {
	Plugin,
	PluginKey,
	TextSelection,
	type EditorState,
	type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { commands, type Period, type SlashCommand } from "./commands.ts";
import type { Task } from "@2do/api/plan";
import { maxRawInputLength, type NewTask } from "@2do/api/notebook";
import { dayKey } from "./calendar.ts";

type Range = { from: number; to: number };
type Draft = Range & { name: string; typeId?: string; alias?:string };
type SlashState = { draft?: Draft; dismissed?: number; index: number };
export const slashKey = new PluginKey<SlashState>("inlineSlash");
type Input = (Range & { kind: "prefix"; query: string }) | (Draft & { kind: "body"; body: string });
type Option = { label: string; command: SlashCommand } | { label: string; task: Task };
export type SlashActions = {
	commands: readonly SlashCommand[];
	tasks: readonly Task[];
	navigate: (period: Period) => void;
	image: () => void;
	carryover: () => void;
	chat: (name: "agent" | "side", body: string) => boolean;
};

export function slashInput(
	state: EditorState,
	catalog?: readonly SlashCommand[],
): Input | undefined {
	const { selection } = state;
	if (
		!(selection instanceof TextSelection) ||
		!selection.empty ||
		!selection.$from.parent.isTextblock
	)
		return;
	const { $from, from } = selection;
	const line = $from.parent.textContent;
	const { draft, dismissed } = slashKey.getState(state) ?? {};
	if (
		draft &&
		from >= draft.from &&
		from <= draft.to &&
		draft.from >= $from.start() &&
		draft.to <= $from.end()
	) {
		const text = state.doc.textBetween(draft.from, draft.to);
		const token = "/" + draft.name + " ";
		if (text.startsWith(token)) {
			if (
				draft.typeId &&
				catalog &&
				!catalog.some(
					(c) => c.kind === "typed" && c.typeId === draft.typeId && c.name === draft.name,
				)
			)
				return;
			return { ...draft, kind: "body", body: text.slice(token.length) };
		}
	}
	// A saved or pasted command line can be finished just like one typed here.
	const saved = (catalog ?? commands).find(
		(c) =>
			(c.kind === "draft" || c.kind === "typed") &&
			line.toLowerCase().startsWith("/" + c.name + " "),
	);
	if (
		(saved?.kind === "draft" || saved?.kind === "typed") &&
		dismissed !== $from.start() &&
		$from.parentOffset >= saved.name.length + 2
	) {
		return {
			kind: "body",
			name: saved.name,
			typeId: saved.kind === "typed" ? saved.typeId : undefined,
			alias: saved.kind === "typed" ? saved.alias : undefined,
			from: $from.start(),
			to: $from.end(),
			body: line.slice(saved.name.length + 2),
		};
	}
	const prefix = /(?:^|\s)(\/[a-z0-9.-]*)$/i.exec(line.slice(0, $from.parentOffset))?.[1];
	if (!prefix || dismissed === from - prefix.length) return;
	return {
		kind: "prefix",
		from: from - prefix.length,
		to: from,
		query: prefix.slice(1).toLowerCase(),
	};
}

export const slashPlugin = new Plugin<SlashState>({
	key: slashKey,
	state: {
		init: () => ({ index: 0 }),
		apply(tr, previous) {
			const meta: SlashState | undefined = tr.getMeta(slashKey);
			if (meta) return meta;
			if (!tr.docChanged && !tr.selectionSet) return previous;
			const draft = previous.draft;
			const start = draft && tr.mapping.mapResult(draft.from, 1);
			const end = draft && tr.mapping.map(draft.to, 1);
			const dismissed =
				previous.dismissed === undefined ? undefined : tr.mapping.map(previous.dismissed, 1);
			return {
				draft:
					draft && start && !start.deleted && end !== undefined && end > start.pos
						? { ...draft, from: start.pos, to: end }
						: undefined,
				dismissed:
					dismissed !== undefined &&
					tr.doc.textBetween(dismissed, Math.min(dismissed + 1, tr.doc.content.size)) === "/"
						? dismissed
						: undefined,
				index: 0,
			};
		},
	},
	props: {
		decorations(state) {
			const input = slashInput(state);
			if (input?.kind !== "body") return null;
			return DecorationSet.create(state.doc, [
				Decoration.inline(input.from, input.from + input.name.length + 1, { class: "slash-token" }),
			]);
		},
	},
});

export function slashOptions(
	input: Input,
	tasks: readonly Task[],
	catalog: readonly SlashCommand[] = commands,
): Option[] {
	if (input.kind === "prefix")
		return catalog
			.filter((c) => c.name.replaceAll(" ", "-").startsWith(input.query))
			.map((command) => ({ label: "/" + command.name, command }));
	if (input.name !== "graph" && input.name !== "link task") return [];
	const search = input.body.trim().toLowerCase();
	return tasks
		.filter((t) => t.title.toLowerCase().includes(search))
		.map((task) => ({ label: task.title, task }));
}

export function slashHint(input: Input): string | undefined {
	if (input.kind !== "body") return;
	if (input.name === "goal") return !input.body.trim() ? "Type a goal" : input.body.trim().length > 240 ? "Use up to 240 characters." : undefined;
	if (input.name === "task" || input.typeId) {
		if (input.body.length > maxRawInputLength)
			return `Task captures can have up to ${maxRawInputLength} characters.`;
		return input.body.trim() ? undefined : "Type a task";
	}
	if (input.name === "side" || input.name === "agent") {
		const message = input.body.trim();
		if (message.length > 2000) return "Messages can have up to 2,000 characters.";
		return message ? undefined : "Type a message";
	}
}

export function insertReference(
	state: EditorState,
	range: Range,
	type: "taskRef" | "graphRef" | "goalRef",
	id: string,
): Transaction {
	const start = state.doc.resolve(range.from);
	const block = start.parent;
	const left = block.content.cut(0, start.parentOffset);
	const right = block.content.cut(range.to - start.start());
	const leading = left.size ? [block.copy(left)] : [];
	const pos = start.before();
	const after = right.size ? block.copy(right) : state.schema.nodes.paragraph.create();
	const tr = state.tr.replaceWith(pos, start.after(), [
		...leading,
		state.schema.nodes[type].create({ id }),
		after,
	]);
	const caret = pos + (leading[0]?.nodeSize ?? 0) + 2;
	return tr
		.setSelection(TextSelection.create(tr.doc, caret))
		.setMeta(slashKey, { index: 0 })
		.scrollIntoView();
}

export function chooseSlash(view: EditorView, actions: SlashActions, index: number, key: string) {
	const { state } = view;
	const input = slashInput(state, actions.commands);
	if (!input) return false;
	const option = slashOptions(input, actions.tasks, actions.commands)[index];
	if (input.kind === "prefix") {
		if (!option || !("command" in option)) return false;
		const { command } = option;
		if (command.kind === "draft" || command.kind === "typed") {
			if ((command.name === "side" || command.name === "agent") && key === "Enter") {
				view.dispatch(state.tr.delete(input.from, input.to));
				actions.chat(command.name, "");
				return true;
			}
			const token = "/" + command.name + " ";
			view.dispatch(
				state.tr.insertText(token, input.from, input.to).setMeta(slashKey, {
					draft: {
						name: command.name,
						typeId: command.kind === "typed" ? command.typeId : undefined,
						alias: command.kind === "typed" ? command.alias : undefined,
						from: input.from,
						to: input.from + token.length,
					},
					index: 0,
				}),
			);
		} else {
			const tr = state.tr.delete(input.from, input.to);
			if (command.kind === "block" && command.name !== "image")
				tr.setBlockType(
					input.from,
					input.from,
					state.schema.nodes[command.name === "heading" ? "heading" : "paragraph"],
				);
			view.dispatch(tr);
			if (command.kind === "date") actions.navigate(command.period);
			else if (command.name === "carryover") actions.carryover();
			else if (command.name === "image") actions.image();
		}
		return true;
	}
	if (input.name === "goal") {
		if (slashHint(input)) return true;
		const goal={id:crypto.randomUUID(),title:input.body.trim()};
		view.dispatch(insertReference(state,input,"goalRef",goal.id).setMeta("newGoal",goal));
	} else if (input.name === "task" || input.typeId) {
		if (slashHint(input)) return true;
		const text = input.body.trim();
		const task: NewTask = {
			id: crypto.randomUUID(),
			title:
				text.length <= 240
					? text
					: text
							.slice(0, 239)
							.replace(/\p{Surrogate}$/u, "")
							.trimEnd() + "…",
			rawInput: input.body,
			...(input.typeId && { typeId: input.typeId }),
			...(input.alias && {alias:input.alias}),
			captureDate: dayKey(new Date()),
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		};
		view.dispatch(insertReference(state, input, "taskRef", task.id).setMeta("newTask", task));
	} else if (input.name === "agent" || input.name === "side") {
		const message = input.body.trim();
		if (message.length <= 2000 && actions.chat(input.name, message))
			view.dispatch(state.tr.delete(input.from, input.to).setMeta(slashKey, { index: 0 }));
	} else if (option && "task" in option) {
		view.dispatch(
			insertReference(
				state,
				input,
				input.name === "graph" ? "graphRef" : "taskRef",
				option.task.id,
			),
		);
	}
	return true;
}

export function slashKeyDown(view: EditorView, event: KeyboardEvent, actions: SlashActions) {
	if (view.composing || event.isComposing || event.altKey || event.metaKey || event.shiftKey)
		return false;
	const input = slashInput(view.state, actions.commands);
	if (!input) return false;
	const local = slashKey.getState(view.state)!;
	const count = slashOptions(input, actions.tasks, actions.commands).length;
	const down = event.key === "ArrowDown" || (event.ctrlKey && event.key === "n");
	const up = event.key === "ArrowUp" || (event.ctrlKey && event.key === "p");
	if (count && (down || up)) {
		view.dispatch(
			view.state.tr.setMeta(slashKey, {
				...local,
				index: (local.index + (down ? 1 : -1) + count) % count,
			}),
		);
		return true;
	}
	if (event.ctrlKey) return false;
	if (event.key === "Escape") {
		view.dispatch(view.state.tr.setMeta(slashKey, { dismissed: input.from, index: 0 }));
		return false; // Let Vim leave Insert mode on the same keystroke.
	}
	if (
		event.key === "Enter" ||
		(event.key === "Tab" && count) ||
		(event.key === " " && input.kind === "prefix")
	)
		return chooseSlash(view, actions, local.index % (count || 1), event.key);
	return false;
}
