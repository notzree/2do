import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { slashKeyDown, slashPlugin, type SlashActions } from "./slash-editor.ts";
import { pageQuery } from "./query.ts";
import { SlashSuggestions } from "./slash-suggestions.tsx";
import { newSideChat, selectChat, sendChat, useChats } from "./chats.ts";
import {
	editSelectedTaskTitle, isTaskInspectorShortcut, NotebookNavigation,
	notebookCommands, titleCaretForKey, toggleSelectedTaskHints,
} from "./commands.ts";
import { useTaskPlugins } from "./task-plugin-api.ts";
import { useQuery } from "@tanstack/react-query";
import { boundCommand, type Bindings } from "./preferences.ts";
import {
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { NotebookReferences } from "./notebook-reference.tsx";
import { Extension } from "@tiptap/core";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import {
	Bold,
	Italic,
	Underline,
	Plus,
	ArrowUp,
	ArrowDown,
	Maximize2,
	Minimize2,
} from "lucide-react";
import { type NotebookDoc } from "@2do/api/notebook";
import { uploadImage } from "./upload-image.ts";
import { dayBuffer, type DayBuffer } from "./day-buffer.ts";
import { editorExtensions, notebookDocument } from "./editor-extensions.ts";
import { bindNotebookEditorEvents, NotebookVim, type EditorMode } from "./editor-navigation.ts";
import { addLine, lineStart, motion, moveLine, removeDeletedTask } from "./editor-keys.ts";
import { dayKey, formatDate, onDay } from "./calendar.ts";
import { TaskList, type ListActions } from "./agenda.tsx";

type EditorNavigationProps = {
	shiftPeriod: (amount: number) => void;
	toggleFocus?: () => void;
	onFocusRequested?: () => void;
};
type Mode = EditorMode;
type DayProps = ListActions &
	EditorNavigationProps & {
		day: Date;
		vim: boolean;
		bindings: Bindings;
		focused: boolean;
		onSelect: () => void;
	};
export function DayEditor({
	day,
	vim,
	bindings,
	focused,
	onSelect,
	toggleFocus,
	onFocusRequested,
	shiftPeriod,
	...actions
}: DayProps) {
	const date = dayKey(day),
		buffer = dayBuffer(date);
	const state = useStore(buffer, useShallow((snapshot) => ({
		generation: snapshot.page ? buffer.generation : null,
		conflict: snapshot.status === "Conflict",
		error: snapshot.error,
		backupWarning: snapshot.backupWarning,
	})));
	const refs = useStore(buffer, useShallow((snapshot) => new Set(
		snapshot.page?.doc.content.flatMap((node) => node.type === "taskRef" ? [node.attrs.id] : []),
	)));
	const page = useQuery(pageQuery(date));
	useEffect(() => {
		if (page.data) buffer.receive(page.data);
	}, [buffer, page.data]);
	useEffect(() => {
		buffer.acknowledgeTasks(actions.plan.tasks);
	}, [buffer, actions.plan.tasks]);
	useEffect(
		() => () => {
			void buffer.flush();
		},
		[buffer],
	);
	const error = state.error ?? page.error?.message;
	const scheduled = actions.plan.tasks.filter((t) => onDay(t, day) && !refs.has(t.id));
	return (
		<article
			className="day-sheet"
			id={"day-" + date}
			data-day={date}
			onFocusCapture={onSelect}
			aria-label={formatDate(day, { dateStyle: "full" })}
		>
			<div className="day-line">
				<h2>{formatDate(day, { weekday: "long" })}</h2>
				<time dateTime={date}>{formatDate(day, { month: "short", day: "numeric" })}</time>
				<span className="day-rule" />
				{date === dayKey(new Date()) && <span className="today-dot">Today</span>}
				{toggleFocus && (
					<button
						type="button"
						className="focus-day"
						onClick={toggleFocus}
						aria-label={
							focused ? "Return to week" : "Focus " + formatDate(day, { weekday: "long" })
						}
						title={
							(focused ? "Return to week" : "Focus this day") + (vim ? " (z in Normal mode)" : "")
						}
					>
						{focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
						{focused && "Return to week"}
					</button>
				)}
			</div>
			{scheduled.length > 0 && <TaskList tasks={scheduled} {...actions} />}
			{state.generation !== null ? (
				<WritingSurface
					key={state.generation}
					buffer={buffer}
					vim={vim}
					bindings={bindings}
					actions={actions}
					toggleFocus={toggleFocus}
					onFocusRequested={onFocusRequested}
					shiftPeriod={shiftPeriod}
				/>
			) : (
				!error && <p role="status">Opening page…</p>
			)}
			{error && (
				<div className="page-error" role="alert">
					{error}{" "}
					{state.conflict ? (
						<button
							onClick={async () => {
								if (window.confirm("Discard the local draft and load the saved page?")) {
									await buffer.discard();
								}
							}}
						>
							Load saved page
						</button>
					) : (
						<button
							onClick={() => void (state.error && state.generation !== null ? buffer.flush() : page.refetch())}
						>
							Retry
						</button>
					)}
				</div>
			)}
			{state.backupWarning && <div className="page-error" role="status">{state.backupWarning}</div>}
		</article>
	);
}

function modeOf(editor: Editor): Mode {
	return editor.storage.vimMode.state.mode === "normal" ? "Normal" : "Insert";
}

const uploadPositions = new Plugin<Map<object, number>>({
	state: {
		init: () => new Map(),
		apply(tr, old) {
			const next = new Map([...old].map(([key, pos]) => [key, tr.mapping.map(pos, -1)]));
			const meta = tr.getMeta("uploadAnchor");
			if (meta?.anchor) next.set(meta.anchor, meta.pos);
			if (meta?.remove) next.delete(meta.remove);
			return next;
		},
	},
});

const WritingPlugins = Extension.create({
	name: "writingPlugins",
	addProseMirrorPlugins() {
		return [uploadPositions, slashPlugin];
	},
});

function WritingSurface({
	buffer,
	vim,
	bindings,
	actions,
	toggleFocus,
	onFocusRequested,
	shiftPeriod,
}: EditorNavigationProps & {
	buffer: DayBuffer;
	vim: boolean;
	bindings: Bindings;
	actions: ListActions;
}) {
	const navigation = useContext(NotebookNavigation);
	const { plugins } = useTaskPlugins();
	const commandCatalog = useMemo(() => notebookCommands(plugins), [plugins]);
	const editorRef = useRef<Editor | null>(null);
	const file = useRef<HTMLInputElement>(null);
	const [mode, setMode] = useState<Mode>("Insert");
	const [active, setActive] = useState(false);
	const [message, setMessage] = useState("");
	const [uploading, setUploading] = useState(0);
	const [marks, setMarks] = useState<string[]>([]);
	const status = useStore(buffer, (snapshot) => snapshot.status);
	useEffect(() => {
		if (active) window.dispatchEvent(new CustomEvent("notebook-mode", { detail: vim ? mode : "Editing" }));
	}, [active, mode, vim]);
	const keySequence = useRef({ key: "", until: 0 });

	const extensions = useMemo(
		() => [
			...editorExtensions(),
			NotebookVim.configure({ deleteTask: (id) => {
				void latest.current.actions.mutate.deleteTask(id);
			} }),
			WritingPlugins.configure({}),
		],
		[],
	);

	function syncView(view: EditorView) {
		const { selection } = view.state;
		const applied = view.state.storedMarks ?? selection.$from.marks();
		setMarks(applied.map((mark) => mark.type.name));
	}
	const slashActions: SlashActions = {
		commands: commandCatalog,
		tasks: actions.plan.tasks,
		navigate: (period) => navigation?.go(period),
		image: () => file.current?.click(),
		chat(name, body) {
			if (name === "agent" && body && useChats.getState().composers.me?.busy) {
				setMessage("The main chat is still responding. Press Enter to send when it finishes.");
				return false;
			}
			const id = name === "side" ? newSideChat() : "me";
			if (name === "agent") selectChat(id);
			if (body) void sendChat(id, body);
			setMessage("");
			return true;
		},
	};
	async function upload(view: EditorView, files: File[]) {
		if (!files.length) return;
		setMessage("");
		setUploading((count) => count + 1);
		const anchor = {};
		view.dispatch(view.state.tr.setMeta("uploadAnchor", { anchor, pos: view.state.selection.to }));
		try {
			const images: ProseMirrorNode[] = [];
			for (const image of files) {
				const id = await uploadImage(image);
				images.push(
					view.state.schema.nodes.image.create({ id, alt: image.name.slice(0, 240) }),
				);
			}
			if (view.isDestroyed) {
				const doc = buffer.get().page!.doc;
				buffer.change({
					...doc,
					content: [...doc.content, ...images.map((node) => node.toJSON()), { type: "paragraph" }],
				});
				return;
			}
			const anchors: Map<object, number> = uploadPositions.getState(view.state)!;
			const at = anchors.get(anchor) ?? view.state.selection.to;
			view.dispatch(view.state.tr.insert(at, images));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Image upload failed.");
		} finally {
			if (!view.isDestroyed)
				view.dispatch(view.state.tr.setMeta("uploadAnchor", { remove: anchor }));
			setUploading((count) => count - 1);
		}
	}

	const latest = useRef({
		vim,
		bindings,
		actions,
		toggleFocus,
		shiftPeriod,
		navigation,
		slashActions,
		upload,
	});
	useLayoutEffect(() => {
		latest.current = {
			vim,
			bindings,
			actions,
			toggleFocus,
			shiftPeriod,
			navigation,
			slashActions,
			upload,
		};
	});
	const tiptapEditor = useEditor(
		{
			extensions,
			content: buffer.get().page!.doc,
			editorProps: {
				attributes: {
					role: "textbox",
					"aria-label": "Day editor " + buffer.date,
					"aria-multiline": "true",
				},
				handlePaste(view, event) {
					const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
						file.type.startsWith("image/"),
					);
					if (!images.length) return false;
					void latest.current.upload(view, images);
					return true;
				},
				handleKeyDown(view, event) {
					if (event.isComposing || view.composing) return false;
					const opts = latest.current;
					const editor = editorRef.current;
					const currentMode = editor ? modeOf(editor) : "Insert";
					if (
						(!opts.vim || currentMode === "Insert") &&
						slashKeyDown(view, event, opts.slashActions)
					)
						return true;
					if (!opts.vim) {
						if (currentMode === "Normal" && editor) {
							editor.commands.enterInsertMode();
						}
						return false;
					}
					const titleCaret = titleCaretForKey(event.key);
					if (currentMode === "Insert") {
						if (event.ctrlKey || event.altKey || event.metaKey || !titleCaret) return false;
						return editSelectedTaskTitle(view, titleCaret);
					}
					if (event.key === "Escape") {
						keySequence.current.key = "";
						return false;
					}
					if (event.ctrlKey && event.key === "r") {
						motion(view, "redo");
						return true;
					}
					const inspect = isTaskInspectorShortcut(event);
					if (inspect) {
						const { selection } = view.state;
						if (!(selection instanceof NodeSelection) || selection.node.type.name !== "taskRef")
							return false;
						if (event.repeat) return true;
					} else if (event.ctrlKey || event.metaKey || event.altKey) return false;
					const key = inspect ? "Enter" : event.key;
					if (key === "d" && event.repeat) return true;
					const prefix =
						performance.now() < keySequence.current.until ? keySequence.current.key : "";
					keySequence.current.key = "";
					const command = prefix === "g" ? boundCommand(opts.bindings, key) : undefined;
					if (command) {
						opts.navigation?.go(command);
						return true;
					}
					if (titleCaret && editSelectedTaskTitle(view, titleCaret)) return true;
					if (key === "z" && opts.toggleFocus) {
						if (!event.repeat) opts.toggleFocus();
						return true;
					}
					if (key === "[" || key === "]") {
						opts.shiftPeriod(key === "[" ? -1 : 1);
						return true;
					}
					if (key === "j" || key === "k") return false;
					if (key === "/" && editor) {
						if (view.state.selection instanceof NodeSelection) addLine(view);
						editor.chain().enterInsertMode().insertContent("/").run();
						return true;
					}
					if ((key === "g" || key === "d") && key !== prefix) {
						keySequence.current = { key, until: performance.now() + 950 };
						return true;
					}
					if (key === "g" || key === "d") {
						if (key === "d") editor?.commands.deleteNotebookBlock();
						else motion(view, "gg");
						return true;
					}
					if (key === "J" || key === "K") {
						moveLine(view, key === "J" ? 1 : -1);
						return true;
					}
					if (["i", "I", "a", "A", "o", "O"].includes(key)) {
						if (key === "o" || key === "O" || view.state.selection instanceof NodeSelection)
							addLine(view, key === "O" || key.toLowerCase() === "i");
						else if (key === "a") motion(view, "l");
						else if (key === "A") motion(view, "$");
						else if (key === "I") motion(view, "^");
						editor?.commands.enterInsertMode();
						return true;
					}
					const pos = lineStart(view);
					const node = view.state.doc.nodeAt(pos);
					if (key === "e") {
						if (node?.type.name !== "taskRef") return false;
						if (!event.repeat) toggleSelectedTaskHints(view);
						return true;
					}
					if (
						(key === "Enter" || key === "x") &&
						node &&
						["taskRef", "graphRef"].includes(node.type.name)
					) {
						const task = opts.actions.plan.tasks.find((item) => item.id === node.attrs.id);
						if (task) {
							if (key === "x")
								void opts.actions.mutate.updateTask(task.id, {
									revision: task.revision,
									completed: !task.completed,
								});
							else opts.actions.open(task, node.type.name === "graphRef");
						}
						return true;
					}
					if (key === "?") {
						opts.navigation?.help();
						return true;
					}
					return motion(view, key) || key.length === 1;
				},
			},
			onCreate({ editor }) {
				editorRef.current = editor;
				setMode(modeOf(editor));
				syncView(editor.view);
			},
			onUpdate({ editor, transaction }) {
				buffer.change(
					notebookDocument(editor.state.doc) as NotebookDoc,
					transaction.getMeta("newTask"),
				);
			},
			onTransaction({ editor, transaction }) {
				if (transaction.selectionSet || transaction.docChanged) keySequence.current.key = "";
				setMode(modeOf(editor));
				if (transaction.docChanged || transaction.selectionSet || transaction.storedMarksSet)
					syncView(editor.view);
			},
		},
		[buffer],
	);

	useLayoutEffect(() => {
		editorRef.current = tiptapEditor;
		return () => {
			editorRef.current = null;
		};
	}, [tiptapEditor]);

	useEffect(() => {
		if (!tiptapEditor) return;
		return buffer.onTaskDeleted((id) => removeDeletedTask(tiptapEditor.view, id));
	}, [buffer, tiptapEditor]);
	useEffect(() => {
		if (!tiptapEditor) return;
		return bindNotebookEditorEvents(tiptapEditor.view, (nextMode) => {
			if (nextMode === "Normal" && latest.current.vim) tiptapEditor.commands.enterNormalMode();
			else tiptapEditor.commands.enterInsertMode();
		});
	}, [tiptapEditor]);
	useEffect(() => {
		if (!onFocusRequested || !tiptapEditor) return;
		if (vim && modeOf(tiptapEditor) !== "Normal") {
			// Entering Normal normally backs up one character. Navigation keeps the destination caret.
			const selection = tiptapEditor.state.selection;
			tiptapEditor
				.chain()
				.enterNormalMode()
				.command(({ tr }) => {
					tr.setSelection(selection);
					return true;
				})
				.run();
		}
		tiptapEditor.view.focus();
		tiptapEditor.view.dispatch(tiptapEditor.state.tr.scrollIntoView());
		onFocusRequested();
	}, [onFocusRequested, tiptapEditor, vim]);
	useEffect(() => {
		if (vim || !tiptapEditor || modeOf(tiptapEditor) !== "Normal") return;
		tiptapEditor.commands.enterInsertMode();
	}, [vim, tiptapEditor]);

	return (
		<div
			className="writing-surface"
			data-mode={vim ? mode : "Insert"}
			onFocus={() => setActive(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					keySequence.current.key = "";
					setActive(false);
					void buffer.flush();
				}
			}}
		>
			<NotebookReferences.Provider value={{ actions, buffer }}>
				<EditorContent editor={tiptapEditor} />
			</NotebookReferences.Provider>
			{active && tiptapEditor && (!vim || mode === "Insert") && (
				<SlashSuggestions
					id={"slash-options-" + buffer.date}
					editor={tiptapEditor}
					actions={slashActions}
				/>
			)}
			<div
				className="writing-tools"
				data-active={active}
				role="toolbar"
				aria-label="Day editor tools"
				onMouseDown={(event) => event.preventDefault()}
			>
				{(
					[
						["strong", Bold],
						["em", Italic],
						["underline", Underline],
					] as const
				).map(([mark, Icon]) => (
					<button
						key={mark}
						aria-label={mark}
						aria-pressed={marks.includes(mark)}
						onClick={() => {
							if (!tiptapEditor) return;
							const toggle =
								mark === "strong"
									? "toggleBold"
									: mark === "em"
										? "toggleItalic"
										: "toggleUnderline";
							tiptapEditor.chain().focus()[toggle]().run();
						}}
					>
						<Icon size={15} />
					</button>
				))}
				<button
					aria-label="Move block up"
					onClick={() => tiptapEditor && moveLine(tiptapEditor.view, -1)}
				>
					<ArrowUp size={15} />
				</button>
				<button
					aria-label="Move block down"
					onClick={() => tiptapEditor && moveLine(tiptapEditor.view, 1)}
				>
					<ArrowDown size={15} />
				</button>
				<button
					aria-label="Insert block"
					onClick={() => {
						if (!tiptapEditor) return;
						const view = tiptapEditor.view;
						if (
							view.state.selection instanceof NodeSelection ||
							view.state.selection.$from.parent.content.size
						)
							addLine(view);
						tiptapEditor.chain().focus().enterInsertMode().insertContent("/").run();
					}}
				>
					<Plus size={16} />
				</button>
				<small>
					{vim ? mode : "Editing"} · {uploading ? "Uploading" : status}
				</small>
			</div>

			<input
				ref={file}
				type="file"
				hidden
				accept="image/png,image/jpeg,image/gif,image/webp"
				onChange={(event) => {
					if (tiptapEditor) void upload(tiptapEditor.view, Array.from(event.target.files ?? []));
					event.target.value = "";
				}}
			/>
			{message && (
				<p className="error" role="alert">
					{message}
				</p>
			)}
		</div>
	);
}
