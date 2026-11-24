import { useRef, useState, type FormEvent } from "react";
import type { Plan, Task } from "@2do/api/plan";
import { dayKey, formatDate, onDay, timeRange } from "./calendar.ts";
import type { Mutate } from "./use-plan.ts";

export type ListActions = {
	plan: Plan;
	busy: boolean;
	mutate: Mutate;
	open: (task: Task, graph?: boolean) => void;
};

// Each date/section is a projection. A child whose parent is elsewhere stays visible.
export function TaskList({ tasks, plan, busy, mutate, open }: ListActions & { tasks: Task[] }) {
	const [folded, setFolded] = useState<Set<string>>(new Set());
	const ids = new Set(tasks.map((t) => t.id));
	const children = new Map<string | null, Task[]>();
	for (const task of tasks) {
		const parent = task.parentId && ids.has(task.parentId) ? task.parentId : null;
		const siblings = children.get(parent) ?? [];
		siblings.push(task);
		children.set(parent, siblings);
	}
	function fold(id: string) {
		setFolded((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	}
	function branch(parent: string | null) {
		return (
			<ul className="outline">
				{children.get(parent)?.map((task) => {
					const group = children.get(task.id);
					const allChildren = plan.tasks.filter((t) => t.parentId === task.id);
					const waiting = plan.edges
						.filter((e) => e.to === task.id)
						.map((e) => plan.tasks.find((t) => t.id === e.from)!)
						.filter((t) => !t.completed);
					const context =
						task.parentId && !ids.has(task.parentId)
							? plan.tasks.find((t) => t.id === task.parentId)?.title
							: "";
					const meta = [
						timeRange(task),
						task.durationMinutes && task.durationMinutes + " min",
						task.kind !== "task" && task.kind,
						context && "In " + context,
						allChildren.length > 0 &&
							allChildren.filter((t) => t.completed).length +
								"/" +
								allChildren.length +
								" subtasks",
					]
						.filter(Boolean)
						.join(" · ");
					return (
						<li key={task.id}>
							<div className={"task-row" + (task.completed ? " completed" : "")}>
								{group ? (
									<button
										className="fold"
										aria-expanded={!folded.has(task.id)}
										aria-label={`Toggle subtasks of ${task.title}`}
										onClick={() => fold(task.id)}
									>
										{folded.has(task.id) ? "▸" : "▾"}
									</button>
								) : (
									<span className="fold-space" />
								)}
								<input
									type="checkbox"
									checked={task.completed}
									disabled={busy}
									aria-label={`Mark ${task.title} ${task.completed ? "incomplete" : "complete"}`}
									onChange={() =>
										void mutate("/api/tasks/" + task.id, "PATCH", { completed: !task.completed })
									}
								/>
								<div className="task-copy">
									<button className="task-title" data-task={task.id} onClick={() => open(task)}>
										{task.title}
									</button>
									{meta && <small>{meta}</small>}
									{!task.completed && waiting.length > 0 && (
										<button className="waiting" onClick={() => open(task, true)}>
											Waiting on {waiting[0].title}
											{waiting.length > 1 && ` +${waiting.length - 1}`}
										</button>
									)}
								</div>
							</div>
							{group && !folded.has(task.id) && branch(task.id)}
						</li>
					);
				})}
			</ul>
		);
	}
	return branch(null);
}

export function Agenda({
	day,
	compact,
	...actions
}: ListActions & { day: Date; compact?: boolean }) {
	const [title, setTitle] = useState("");
	const [adding, setAdding] = useState(false);
	const quickAdd = useRef<HTMLInputElement>(null);
	const tasks = actions.plan.tasks.filter((t) => onDay(t, day));
	const fixed = tasks
		.filter((t) => !t.completed && t.schedule?.type === "fixed")
		.sort(
			(a, b) =>
				Date.parse((a.schedule as { start: string }).start) -
				Date.parse((b.schedule as { start: string }).start),
		);
	const anytime = tasks.filter((t) => !t.completed && t.schedule?.type !== "fixed");
	const done = tasks.filter((t) => t.completed);
	async function add(event: FormEvent) {
		event.preventDefault();
		if (
			title.trim() &&
			(await actions.mutate("/api/tasks", "POST", {
				title,
				schedule: { type: "day", date: dayKey(day) },
			}))
		)
			setTitle((current) => (current === title ? "" : current));
	}
	return (
		<section className={"agenda" + (compact ? " compact" : "")} data-day={dayKey(day)}>
			{compact && (
				<div className="section-head">
					<h2>{formatDate(day, { weekday: "short", month: "short", day: "numeric" })}</h2>
					<button
						className="plain"
						data-add-day
						onClick={() => {
							setAdding(true);
							requestAnimationFrame(() => quickAdd.current?.focus());
						}}
					>
						+ Add task
					</button>
				</div>
			)}
			{(!compact || adding) && (
				<form className="quick-add" onSubmit={add}>
					<span aria-hidden="true">＋</span>
					<input
						data-quick-add
						aria-label="New task title"
						placeholder="Add a task…"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						maxLength={240}
						ref={quickAdd}
					/>
					<button disabled={actions.busy || !title.trim()}>Add</button>
				</form>
			)}
			{fixed.length > 0 && (
				<>
					<h3>Scheduled</h3>
					<TaskList tasks={fixed} {...actions} />
				</>
			)}
			{anytime.length > 0 && (
				<>
					<h3>Anytime</h3>
					<TaskList tasks={anytime} {...actions} />
				</>
			)}
			{!tasks.length && (
				<p className="muted">{compact ? "No tasks" : "Nothing scheduled for this day."}</p>
			)}
			{done.length > 0 && (
				<details>
					<summary>Completed · {done.length}</summary>
					<TaskList tasks={done} {...actions} />
				</details>
			)}
		</section>
	);
}
