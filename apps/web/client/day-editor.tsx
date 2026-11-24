import {boundCommand,type Bindings} from "./preferences.ts";
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from "react";
import {createPortal} from "react-dom";
import {Extension} from "@tiptap/core";
import {EditorContent,useEditor,type Editor} from "@tiptap/react";
import {VimMode} from "@prose-motions/core";
import {NodeSelection,Plugin,TextSelection} from "@tiptap/pm/state";
import {Decoration,DecorationSet} from "@tiptap/pm/view";
import type {Node as ProseMirrorNode} from "@tiptap/pm/model";
import type {EditorView,NodeView} from "@tiptap/pm/view";
import {Bold,Italic,Underline,Plus,GripVertical,ArrowUp,ArrowDown,GitBranch,SquareCheck,ImagePlus,Heading2,Text,Link2} from "lucide-react";
import type {Task} from "@2do/api/plan";
import type {NotebookDoc,NewTask} from "@2do/api/notebook";
import {dayBuffer,type DayBuffer} from "./day-buffer.ts";
import {editorExtensions,notebookDocument,type Widget} from "./editor-extensions.ts";
import {bindNotebookEditorEvents,type EditorMode} from "./editor-navigation.ts";
import {addLine,lineStart,motion,moveLine,selectLine,stepLine} from "./editor-keys.ts";
import {dayKey,formatDate,onDay,timeRange} from "./calendar.ts";
import {TaskList,type ListActions} from "./agenda.tsx";
import {DependencyGraph} from "./graph.tsx";

const commands=[
	{name:"Task",icon:SquareCheck,hint:"Create from this line"},
	{name:"Link task",icon:Link2,hint:"Reference an existing task"},
	{name:"Graph",icon:GitBranch,hint:"Embed task dependencies"},
	{name:"Heading",icon:Heading2,hint:"Section heading"},
	{name:"Text",icon:Text,hint:"Plain paragraph"},
	{name:"Image",icon:ImagePlus,hint:"Upload an image"},
] as const;
type Command=typeof commands[number]["name"];
type Mode=EditorMode;
type DayProps=ListActions & {day:Date;vim:boolean;bindings:Bindings};
function focusNeighbor(view:EditorView,dir:1|-1){
	const editors=Array.from(document.querySelectorAll<HTMLElement>(".ProseMirror"));
	const next=editors[editors.indexOf(view.dom)+dir];
	if(next)next.dispatchEvent(new CustomEvent("notebook-enter",{detail:dir}));
}
function GraphEmbed({task,actions}:{task:Task;actions:ListActions}){
	const [focus,setFocus]=useState(task.id);
	return <DependencyGraph plan={actions.plan} task={actions.plan.tasks.find(t=>t.id===focus)??task} select={setFocus} inline/>;
}
export function DayEditor({day,vim,bindings,...actions}:DayProps){
	const date=dayKey(day), buffer=dayBuffer(date);
	const state=useSyncExternalStore(buffer.subscribe,buffer.get);
	useEffect(()=>{void buffer.load();return ()=>{void buffer.flush();};},[buffer]);
	const [epoch,setEpoch]=useState(0);
	const refs=new Set(state.page?.doc.content.flatMap(n=>n.type==="taskRef"?[n.attrs.id]:[])??[]);
	const scheduled=actions.plan.tasks.filter(t=>onDay(t,day) && !refs.has(t.id));
	return <article className="day-sheet" id={"day-"+date} data-day={date} aria-label={formatDate(day,{dateStyle:"full"})}>
		<div className="day-line"><h2>{formatDate(day,{weekday:"long"})}</h2><time dateTime={date}>{formatDate(day,{month:"short",day:"numeric"})}</time><span className="day-rule"/>{date===dayKey(new Date())&&<span className="today-dot">Today</span>}</div>
		{scheduled.length>0 && <TaskList tasks={scheduled} {...actions}/>}
		{state.page ? <WritingSurface key={epoch} buffer={buffer} vim={vim} bindings={bindings} actions={actions}/> : !state.error && <p role="status">Opening page…</p>}
		{state.error && <div className="page-error" role="alert">{state.error} {state.status==="Conflict"?<button onClick={async()=>{if(window.confirm("Discard the local draft and load the saved page?")){await buffer.load(true);if(buffer.get().status==="Saved")setEpoch(n=>n+1);}}}>Load saved page</button>:<button onClick={()=>void(state.page?buffer.flush():buffer.load())}>Retry</button>}</div>}
	</article>;
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

const emptyLine = new Plugin({
	props: {
		decorations(state) {
			const first = state.doc.firstChild;
			if (state.doc.childCount !== 1 || first?.type.name !== "paragraph" || first.content.size)
				return null;
			return DecorationSet.create(state.doc, [
				Decoration.node(0, first.nodeSize, { class: "empty-line" }),
			]);
		},
	},
});

const WritingPlugins = Extension.create({
	name: "writingPlugins",
	addProseMirrorPlugins() {
		return [uploadPositions, emptyLine];
	},
});

function WritingSurface({buffer,vim,bindings,actions}:{buffer:DayBuffer;vim:boolean;bindings:Bindings;actions:ListActions}){
	const editorRef = useRef<Editor | null>(null);
	const file = useRef<HTMLInputElement>(null);
	const [widgets, setWidgets] = useState<Widget[]>([]);
	const [mode, setMode] = useState<Mode>("Insert");
	const [active, setActive] = useState(false);
	const [menu, setMenu] = useState(false);
	const [query, setQuery] = useState("");
	const [choice, setChoice] = useState(0);
	const [picker, setPicker] = useState<Command | null>(null);
	const [value, setValue] = useState("");
	const [message, setMessage] = useState("");
	const [uploading, setUploading] = useState(0);
	const [marks, setMarks] = useState<string[]>([]);
	const status = useSyncExternalStore(buffer.subscribe, buffer.get).status;
	const pendingTask = useRef<NewTask | undefined>(undefined);
	const slashRange = useRef<{ from: number; to: number } | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const keySequence = useRef({ key: "", until: 0 });
	const available = commands.filter((command) => command.name.toLowerCase().startsWith(query.toLowerCase()));

	const registerWidget = useCallback((widget: Widget, remove = false) => {
		setWidgets((old) => remove ? old.filter((item) => item !== widget) : [...old, widget]);
	}, []);
	const extensions = useMemo(
		() => [
			...editorExtensions(registerWidget),
			VimMode.configure({}),
			WritingPlugins.configure({}),
		],
		[registerWidget],
	);

	function closeMenu() {
		setMenu(false);
		setChoice(0);
		setQuery("");
	}
	function syncView(view: EditorView) {
		const { selection } = view.state;
		const parent = selection.$from.parent;
		const match = selection.empty && parent.isTextblock && /^\/([\w ]*)$/.exec(parent.textContent);
		const currentEditor = editorRef.current;
		const insertMode = currentEditor ? modeOf(currentEditor) === "Insert" : mode === "Insert";
		if (match && insertMode) {
			slashRange.current = { from: selection.$from.start(), to: selection.$from.end() };
			setQuery(match[1]);
			setMenu(true);
			setChoice(0);
		} else {
			slashRange.current = null;
			closeMenu();
		}
		const applied = view.state.storedMarks ?? selection.$from.marks();
		setMarks(applied.map((mark) => mark.type.name));
	}
	function removeSlash(view: EditorView) {
		const range = slashRange.current;
		if (range) {
			slashRange.current = null;
			view.dispatch(view.state.tr.delete(range.from, range.to));
		}
		closeMenu();
	}
	function addEmbed(view: EditorView, type: "taskRef" | "graphRef", id: string) {
		const pos = lineStart(view);
		const old = view.state.doc.nodeAt(pos)!;
		const tr = view.state.tr.replaceWith(pos, pos + old.nodeSize, [
			view.state.schema.nodes[type].create({ id }),
			view.state.schema.nodes.paragraph.create(),
		]);
		view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 2)).scrollIntoView());
		editorRef.current?.commands.enterInsertMode();
		setMode("Insert");
		view.focus();
	}
	function command(name: Command) {
		const editor = editorRef.current;
		if (!editor) return;
		removeSlash(editor.view);
		if (name === "Heading" || name === "Text") {
			editor.chain().focus().setNode(name === "Heading" ? "heading" : "paragraph").run();
			return;
		}
		if (name === "Image") {
			file.current?.click();
			return;
		}
		const selected = editor.state.doc.nodeAt(lineStart(editor.view));
		setValue(name === "Task" ? selected?.textContent.slice(0, 240) ?? "" : "");
		setPicker(name);
	}
	function finishPicker(id?: string) {
		const view = editorRef.current?.view;
		if (!view) return;
		if (picker === "Task") {
			if (!value.trim()) return;
			const task = { id: crypto.randomUUID(), title: value.trim() };
			pendingTask.current = task;
			addEmbed(view, "taskRef", task.id);
		} else if (id) {
			if (view.state.doc.nodeAt(lineStart(view))?.textContent) addLine(view);
			addEmbed(view, picker === "Graph" ? "graphRef" : "taskRef", id);
		}
		setPicker(null);
	}
	async function upload(view: EditorView, files: File[]) {
		if (!files.length) return;
		setMessage("");
		setUploading((count) => count + 1);
		const anchor = {};
		view.dispatch(view.state.tr.setMeta("uploadAnchor", { anchor, pos: view.state.selection.to }));
		try {
			const images: ProseMirrorNode[] = [];
			for (const image of files) {
				if (image.size > 8 * 1024 * 1024) throw new Error("Choose images smaller than 8 MiB.");
				const response = await fetch("/api/images", {
					method: "POST",
					body: image,
					headers: { "Content-Type": image.type },
					redirect: "error",
				});
				const receipt = await response.json();
				if (!response.ok) throw new Error(receipt.error ?? "Image upload failed.");
				images.push(
					view.state.schema.nodes.image.create({ id: receipt.id, alt: image.name.slice(0, 240) }),
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
			if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta("uploadAnchor", { remove: anchor }));
			setUploading((count) => count - 1);
		}
	}

	const latest = useRef({ vim, bindings, actions, menu, choice, query, command, upload });
	useLayoutEffect(() => {
		latest.current = { vim, bindings, actions, menu, choice, query, command, upload };
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
					"data-placeholder": "Write a note, or type / for commands…",
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
					if (event.isComposing) return false;
					const opts = latest.current;
					if (opts.menu) {
						const items = commands.filter((item) =>
							item.name.toLowerCase().startsWith(opts.query.toLowerCase()),
						);
						if (event.key === "Escape") {
							closeMenu();
							return true;
						}
						if (items.length && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
							if (event.key === "Enter" || event.key === "Tab")
								opts.command(items[opts.choice % items.length].name);
							else setChoice((opts.choice + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
							return true;
						}
					}
					const editor = editorRef.current;
					const currentMode = editor ? modeOf(editor) : "Insert";
					if (!opts.vim) {
						if (currentMode === "Normal" && editor) {
							editor.commands.enterInsertMode();
							setMode("Insert");
						}
						return false;
					}
					if (event.key === "Escape" && currentMode === "Insert") {
						setMode("Normal");
						return false;
					}
					if (currentMode === "Insert") return false;
					if (event.key === "Escape") return false;
					if (event.ctrlKey && event.key === "r") {
						motion(view, "redo");
						return true;
					}
					if (event.ctrlKey || event.metaKey || event.altKey) return false;
					const key = event.key;
					const prefix = performance.now() < keySequence.current.until ? keySequence.current.key : "";
					keySequence.current.key = "";
					const command = prefix === "g" ? boundCommand(opts.bindings, key) : undefined;
					if (command) {
						window.dispatchEvent(new CustomEvent("notebook-go", { detail: command }));
						return true;
					}
					if (key === "i") {
						setMode("Insert");
						return false;
					}
					if ((key === "g" || key === "d") && key !== prefix) {
						keySequence.current = { key, until: performance.now() + 950 };
						return true;
					}
					if (key === "g" || key === "d") {
						motion(view, key + key);
						return true;
					}
					if (key === "j" || key === "k") {
						const direction = key === "j" ? 1 : -1;
						if (!stepLine(view, direction)) focusNeighbor(view, direction);
						return true;
					}
					if (key === "J" || key === "K") {
						moveLine(view, key === "J" ? 1 : -1);
						return true;
					}
					if (key === "a" || key === "o" || key === "O") {
						if (key === "o" || key === "O" || view.state.selection instanceof NodeSelection)
							addLine(view, key === "O");
						else if (key === "a") motion(view, "l");
						editor?.commands.enterInsertMode();
						setMode("Insert");
						return true;
					}
					const node = view.state.doc.nodeAt(lineStart(view));
					if ((key === "Enter" || key === "x") && node && ["taskRef", "graphRef"].includes(node.type.name)) {
						const task = opts.actions.plan.tasks.find((item) => item.id === node.attrs.id);
						if (task) {
							if (key === "x")
								void opts.actions.mutate("/api/tasks/" + task.id, "PATCH", {
									completed: !task.completed,
								});
							else opts.actions.open(task, node.type.name === "graphRef");
						}
						return true;
					}
					if (key === "/") {
						closeMenu();
						setMenu(true);
						return true;
					}
					if (key === "?") {
						window.dispatchEvent(new Event("notebook-help"));
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
			onUpdate({ editor }) {
				buffer.change(notebookDocument(editor.state.doc) as NotebookDoc, pendingTask.current);
				pendingTask.current = undefined;
			},
			onTransaction({ editor, transaction }) {
				if (transaction.docChanged || transaction.selectionSet || transaction.storedMarksSet)
					syncView(editor.view);
			},
		},
		[buffer],
	);
	editorRef.current = tiptapEditor;

	useEffect(() => {
		if (!tiptapEditor) return;
		return bindNotebookEditorEvents(tiptapEditor.view, (nextMode) => {
			if (nextMode === "Normal") tiptapEditor.commands.enterNormalMode();
			else tiptapEditor.commands.enterInsertMode();
			setMode(nextMode);
		});
	}, [tiptapEditor]);
	useEffect(() => {
		if (vim || !tiptapEditor || modeOf(tiptapEditor) !== "Normal") return;
		tiptapEditor.commands.enterInsertMode();
		setMode("Insert");
	}, [vim, tiptapEditor]);
	useEffect(() => {
		if (picker) inputRef.current?.focus();
	}, [picker]);

	return (
		<div
			className="writing-surface"
			data-mode={vim ? mode : "Insert"}
			onFocus={() => setActive(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					setActive(false);
					closeMenu();
					void buffer.flush();
				}
			}}
		>
			<EditorContent editor={tiptapEditor} />
			{widgets.map((widget) => {
				const task = actions.plan.tasks.find((item) => item.id === widget.id);
				return createPortal(
					<>
						<span className="embed-grip" title="Drag to reorder">
							<GripVertical size={14} />
						</span>
						{widget.kind === "graphRef" && task ? (
							<GraphEmbed task={task} actions={actions} />
						) : (
							<>
								<input
									type="checkbox"
									disabled={!task || actions.busy}
									checked={task?.completed ?? false}
									aria-label="Toggle task completion"
									onChange={() =>
										task && void actions.mutate("/api/tasks/" + task.id, "PATCH", {
											completed: !task.completed,
										})
									}
								/>
								<button
									className={"embed-title" + (task?.completed ? " done" : "")}
									onClick={() => task && actions.open(task)}
								>
									{task?.title ?? buffer.taskTitle(widget.id) ?? "Unavailable task"}
								</button>
								{task && <small>{timeRange(task)}</small>}
							</>
						)}
					</>,
					widget.dom,
				);
			})}
			<div className="writing-tools" data-active={active} role="toolbar" aria-label="Day editor tools" onMouseDown={(event) => event.preventDefault()}>
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
							const toggle = mark === "strong" ? "toggleBold" : mark === "em" ? "toggleItalic" : "toggleUnderline";
							tiptapEditor.chain().focus()[toggle]().run();
						}}
					>
						<Icon size={15} />
					</button>
				))}
				<button aria-label="Move block up" onClick={() => tiptapEditor && moveLine(tiptapEditor.view, -1)}>
					<ArrowUp size={15} />
				</button>
				<button aria-label="Move block down" onClick={() => tiptapEditor && moveLine(tiptapEditor.view, 1)}>
					<ArrowDown size={15} />
				</button>
				<button
					aria-label="Insert block"
					onClick={() => {
						setMenu(!menu);
						setQuery("");
						setChoice(0);
						tiptapEditor?.commands.focus();
					}}
				>
					<Plus size={16} />
				</button>
				<small>{vim ? mode : "Editing"} · {uploading ? "Uploading" : status}</small>
			</div>
			{menu && (
				<div className="command-menu" role="group" aria-label="Insert a block">
					{available.length ? (
						available.map(({ name, icon: Icon, hint }, index) => (
							<button
								key={name}
								className={choice === index ? "chosen" : ""}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => command(name)}
							>
								<Icon size={16} />
								<span>
									{name}
									<small>{hint}</small>
								</span>
							</button>
						))
					) : (
						<small>No matching command</small>
					)}
				</div>
			)}
			{picker && (
				<form
					className="embed-picker"
					onSubmit={(event) => {
						event.preventDefault();
						if (picker === "Task") finishPicker();
						else {
							const first = actions.plan.tasks.find((task) =>
								task.title.toLowerCase().includes(value.toLowerCase()),
							);
							if (first) finishPicker(first.id);
						}
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.stopPropagation();
							setPicker(null);
							tiptapEditor?.commands.focus();
						}
					}}
				>
					<label>
						{picker === "Task" ? "New task title" : picker === "Graph" ? "Graph starting task" : "Link a task"}
						<input
							ref={inputRef}
							value={value}
							maxLength={240}
							onChange={(event) => setValue(event.target.value)}
							placeholder={picker === "Task" ? "Task title" : "Find a task…"}
						/>
					</label>
					{picker === "Task" ? (
						<button disabled={!value.trim()}>Create task</button>
					) : (
						<div className="picker-results">
							{actions.plan.tasks
								.filter((task) => task.title.toLowerCase().includes(value.toLowerCase()))
								.map((task) => (
									<button type="button" key={task.id} onClick={() => finishPicker(task.id)}>
										{task.title}
									</button>
								))}
							{!actions.plan.tasks.some((task) =>
								task.title.toLowerCase().includes(value.toLowerCase()),
							) && <small>No matching task</small>}
						</div>
					)}
					<button type="button" onClick={() => {
						setPicker(null);
						tiptapEditor?.commands.focus();
					}}>
						Cancel
					</button>
				</form>
			)}
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
			{message && <p className="error" role="alert">{message}</p>}
		</div>
	);
}
