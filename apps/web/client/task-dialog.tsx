import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { kind, type Task, type Plan } from "@2do/api/plan";
import { dayKey } from "./calendar.ts";
import { DependencyGraph } from "./graph.tsx";
import type { Mutate } from "./use-plan.ts";

export function Modal({
	title,
	close,
	children,
}: {
	title: string;
	close: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current!;
		dialog.showModal();
		return () => dialog.close();
	}, []);
	return (
		<dialog
			ref={ref}
			aria-label={title}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
		>
			<div className="section-head">
				<h2>{title}</h2>
				<button className="plain" onClick={close} aria-label="Close dialog">
					Close
				</button>
			</div>
			{children}
		</dialog>
	);
}

function localTime(value: string) {
	const date = new Date(value);
	return (
		dayKey(date) +
		"T" +
		[date.getHours(), date.getMinutes()].map((x) => String(x).padStart(2, "0")).join(":")
	);
}
function TaskEditor({
	task,
	plan,
	day,
	mutate,
	busy,
}: {
	task: Task;
	plan: Plan;
	day: string;
	mutate: Mutate;
	busy: boolean;
}) {
	const s = task.schedule;
	const [title, setTitle] = useState(task.title),
		[type, setType] = useState(s?.type ?? "none");
	const [date, setDate] = useState(s?.type === "day" ? s.date : day);
	const [start, setStart] = useState(s && s.type !== "day" ? localTime(s.start) : day + "T09:00");
	const [end, setEnd] = useState(s && s.type !== "day" ? localTime(s.end) : day + "T10:00");
	const [taskKind, setKind] = useState(task.kind),
		[parent, setParent] = useState(task.parentId ?? "");
	const [duration, setDuration] = useState(task.durationMinutes?.toString() ?? "");
	const [saved, setSaved] = useState(false);
	async function save(e: FormEvent) {
		e.preventDefault();
		let schedule: Task["schedule"] = null;
		if (type === "day") schedule = { type, date };
		if (type === "window" || type === "fixed") {
			// Preserve precise timestamps, including repeated DST hours, when only another field changes.
			const iso = (value: string, original?: string) =>
				original && localTime(original) === value ? original : new Date(value).toISOString();
			schedule = {
				type,
				start: iso(start, s && s.type !== "day" ? s.start : undefined),
				end: iso(end, s && s.type !== "day" ? s.end : undefined),
			};
		}
		setSaved(
			await mutate("/api/tasks/" + task.id, "PATCH", {
				title,
				kind: taskKind,
				parentId: parent || null,
				schedule,
				durationMinutes: duration ? Number(duration) : null,
			}),
		);
	}
	return (
		<form className="editor" onSubmit={save} onChange={() => setSaved(false)}>
			<label>
				Title
				<input
					data-edit-title
					required
					maxLength={240}
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<div className="field-pair">
				<label>
					Kind
					<select value={taskKind} onChange={(e) => setKind(kind.parse(e.target.value))}>
						{kind.options.map((k) => (
							<option key={k}>{k}</option>
						))}
					</select>
				</label>
				<label>
					Duration (minutes)
					<input
						type="number"
						min="1"
						max="525600"
						value={duration}
						onChange={(e) => setDuration(e.target.value)}
					/>
				</label>
			</div>
			<label>
				Schedule
				<select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
					<option value="none">Unscheduled</option>
					<option value="day">Anytime on a day</option>
					<option value="fixed">Fixed time</option>
					<option value="window">Flexible window</option>
				</select>
			</label>
			{type === "day" && (
				<label>
					Day
					<input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
				</label>
			)}
			{(type === "fixed" || type === "window") && (
				<div className="field-pair">
					<label>
						Start
						<input
							type="datetime-local"
							required
							value={start}
							onChange={(e) => setStart(e.target.value)}
						/>
					</label>
					<label>
						End
						<input
							type="datetime-local"
							required
							min={start}
							value={end}
							onChange={(e) => setEnd(e.target.value)}
						/>
					</label>
				</div>
			)}
			<label>
				Parent task
				<select value={parent} onChange={(e) => setParent(e.target.value)}>
					<option value="">Top level</option>
					{plan.tasks
						.filter((t) => t.id !== task.id)
						.map((t) => (
							<option key={t.id} value={t.id}>
								{t.title}
							</option>
						))}
				</select>
			</label>
			<div className="actions">
				<button className="primary" disabled={busy || !title.trim()}>
					Save changes
				</button>
				{saved && <small role="status">Saved</small>}
			</div>
		</form>
	);
}

export function TaskDialog({
	plan,
	task,
	graph,
	showGraph,
	select,
	close,
	mutate,
	busy,
	error,
	day,
}: {
	plan: Plan;
	task: Task;
	graph: boolean;
	showGraph: (v: boolean) => void;
	select: (id: string) => void;
	close: () => void;
	mutate: Mutate;
	busy: boolean;
	error: string;
	day: string;
}) {
	const [sub, setSub] = useState(""),
		[prereq, setPrereq] = useState("");
	const before = plan.edges.filter((e) => e.to === task.id).map((e) => e.from);
	const children = plan.tasks.filter((t) => t.parentId === task.id);
	return (
		<Modal title={task.title} close={close}>
			<div className="switcher">
				<button aria-pressed={!graph} onClick={() => showGraph(false)}>
					Details
				</button>
				<button aria-pressed={graph} onClick={() => showGraph(true)}>
					Graph
				</button>
			</div>
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			{graph && <DependencyGraph plan={plan} task={task} select={select} />}
			<div hidden={graph}>
				<TaskEditor task={task} plan={plan} day={day} mutate={mutate} busy={busy} />
				<h3>Subtasks</h3>
				{children.map((t) => (
					<button className="relation" key={t.id} onClick={() => select(t.id)}>
						{t.completed ? "✓ " : ""}
						{t.title} ›
					</button>
				))}
				<form
					className="inline-form"
					onSubmit={async (e) => {
						e.preventDefault();
						if (
							await mutate("/api/tasks", "POST", {
								title: sub,
								parentId: task.id,
								schedule: task.schedule
									? {
											type: "day",
											date:
												task.schedule.type === "day"
													? task.schedule.date
													: dayKey(new Date(task.schedule.start)),
										}
									: null,
							})
						)
							setSub("");
					}}
				>
					<input
						aria-label="Subtask title"
						placeholder="Subtask title"
						value={sub}
						maxLength={240}
						onChange={(e) => setSub(e.target.value)}
					/>
					<button disabled={busy || !sub.trim()}>Add subtask</button>
				</form>
				<h3>Prerequisites</h3>
				{before.map((id) => (
					<div className="section-head" key={id}>
						<button className="relation" onClick={() => select(id)}>
							{plan.tasks.find((t) => t.id === id)?.title}
						</button>
						<button
							className="plain"
							disabled={busy}
							onClick={() => void mutate("/api/dependencies/" + id + "/" + task.id, "DELETE")}
						>
							Unlink
						</button>
					</div>
				))}
				<form
					className="inline-form"
					onSubmit={async (e) => {
						e.preventDefault();
						if (prereq && (await mutate("/api/dependencies/" + prereq + "/" + task.id, "PUT")))
							setPrereq("");
					}}
				>
					<select
						aria-label="Prerequisite task"
						value={prereq}
						onChange={(e) => setPrereq(e.target.value)}
					>
						<option value="">Choose task…</option>
						{plan.tasks
							.filter((t) => t.id !== task.id && !before.includes(t.id))
							.map((t) => (
								<option key={t.id} value={t.id}>
									{t.title}
								</option>
							))}
					</select>
					<button disabled={busy || !prereq}>Add prerequisite</button>
				</form>
				<button
					className="danger"
					disabled={busy}
					onClick={async () => {
						if (
							window.confirm(
								"Delete this task and its prerequisite links? Its subtasks will be kept.",
							) &&
							(await mutate("/api/tasks/" + task.id, "DELETE"))
						)
							close();
					}}
				>
					Delete task
				</button>
			</div>
		</Modal>
	);
}
