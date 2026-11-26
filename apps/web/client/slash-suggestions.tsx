import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { useLayoutEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import {
	CalendarDays,
	CornerDownLeft,
	Heading,
	Image,
	Link2,
	MessageSquare,
	Network,
	NotebookPen,
	SquareCheck, Target,
} from "lucide-react";
import type { SlashCommand } from "./commands.ts";
import { TaskTypeIcon } from "./task-type-icon.tsx";
import "./slash-picker.css";
import {
	chooseSlash,
	slashHint,
	slashInput,
	slashKey,
	slashOptions,
	type SlashActions,
} from "./slash-editor.ts";

const commandIcons = {
	carryover: CalendarDays, task: SquareCheck, goal:Target,
	note: NotebookPen,
	text: NotebookPen,
	heading: Heading,
	image: Image,
	"link task": Link2,
	graph: Network,
	agent: MessageSquare,
	side: MessageSquare,
};
function CommandIcon({ command }: { command?: SlashCommand }) {
	if (command?.kind === "typed") return <TaskTypeIcon icon={command.icon} size={15} />;
	const Icon = command?.kind === "date" ? CalendarDays : commandIcons[command?.name ?? "task"];
	return <Icon size={15} aria-hidden="true" />;
}

export function SlashSuggestions({
	editor,
	actions,
	id,
}: {
	editor: Editor;
	actions: SlashActions;
	id: string;
}) {
	const menu = useRef<HTMLDivElement>(null);
	const input = slashInput(editor.state, actions.commands);
	const options = input ? slashOptions(input, actions.tasks, actions.commands) : [];
	const index = (slashKey.getState(editor.state)?.index ?? 0) % (options.length || 1);
	const hint =
		input &&
		(slashHint(input) ??
			(input.kind === "body" &&
			!options.length &&
			(input.name === "graph" || input.name === "link task")
				? "No matching tasks"
				: undefined));
	const visible = !!input && (!!options.length || !!hint);
	const anchor = input?.kind === "prefix" ? input.from : editor.state.selection.from;
	useLayoutEffect(() => {
		const el = menu.current;
		if (!el || !visible) return;
		const caret = {
			contextElement: editor.view.dom,
			getBoundingClientRect() {
				const { left, top, right, bottom } = editor.view.coordsAtPos(anchor);
				return new DOMRect(left, top, right - left, bottom - top);
			},
		};
		let active = true;
		const cleanup = autoUpdate(caret, el, () => {
			if (editor.isDestroyed || anchor > editor.state.doc.content.size) return;
			void computePosition(caret, el, {
				placement: "bottom-start",
				middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
			}).then(({ x, y }) => {
				if (active) Object.assign(el.style, { left: x + "px", top: y + "px" });
			});
		});
		return () => {
			active = false;
			cleanup();
		};
	}, [editor, visible, anchor]);
	useLayoutEffect(() => {
		const el = menu.current;
		const option = el?.querySelector<HTMLElement>('[aria-selected="true"]');
		if (!el || !option) return;
		if (option.offsetTop < el.scrollTop) el.scrollTop = option.offsetTop;
		else if (option.offsetTop + option.offsetHeight > el.scrollTop + el.clientHeight)
			el.scrollTop = option.offsetTop + option.offsetHeight - el.clientHeight;
	}, [index, options.length]);
	useLayoutEffect(() => {
		if (editor.isDestroyed || !options.length) return;
		const dom = editor.view.dom;
		dom.setAttribute("aria-controls", id);
		dom.setAttribute("aria-activedescendant", id + "-" + index);
		return () => {
			dom.removeAttribute("aria-controls");
			dom.removeAttribute("aria-activedescendant");
		};
	}, [editor, id, index, options.length]);
	if (!visible) return null;
	return (
		<div className="slash-suggestions slash-picker" ref={menu}>
			{options.length > 0 && (
				<>
					<div className="slash-picker-heading">
						{input?.kind === "body" ? "Matching tasks" : "Insert block"}
					</div>
					<div
						role="listbox"
						id={id}
						aria-label={input?.kind === "body" ? "Matching tasks" : "Slash commands"}
					>
						{options.map((option, i) => (
							<button
								key={"command" in option ? option.label : option.task.id}
								type="button"
								role="option"
								aria-selected={i === index}
								id={id + "-" + i}
								tabIndex={-1}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => chooseSlash(editor.view, actions, i, "click")}
							>
								<CommandIcon command={"command" in option ? option.command : undefined} />
								<span className="slash-picker-label">{option.label}</span>
								{"command" in option && (
									<span className="slash-picker-description">{option.command.description}</span>
								)}
								<CornerDownLeft className="slash-picker-enter" size={13} aria-hidden="true" />
							</button>
						))}
					</div>
				</>
			)}
			{hint && <small role="status">{hint}</small>}
		</div>
	);
}
