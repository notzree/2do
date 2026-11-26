import type { Task, PatchTask } from "@2do/api/plan";
import { dayKey } from "./calendar.ts";

export function localTime(value: string) {
	const date = new Date(value);
	return (
		dayKey(date) +
		"T" +
		[date.getHours(), date.getMinutes()].map((x) => String(x).padStart(2, "0")).join(":")
	);
}
export function taskForm(task: Task, day: string) {
	const schedule = task.schedule;
	return {
		title: task.title,
		dueDay: task.due?.type === "day" ? task.due.date : task.due?.type === "time" ? localTime(task.due.at).slice(0,10) : "",
		dueTime: task.due?.type === "time" ? localTime(task.due.at).slice(11) : "",
		type: schedule?.type ?? ("none" as const),
		date: schedule?.type === "day" ? schedule.date : day,
		start: schedule && schedule.type !== "day" ? localTime(schedule.start) : day + "T09:00",
		end: schedule && schedule.type !== "day" ? localTime(schedule.end) : day + "T10:00",
		taskKind: task.kind,
		parent: task.parentId ?? "",
		duration: task.durationMinutes?.toString() ?? "",
	};
}
export type TaskForm = ReturnType<typeof taskForm>;

function editedFields(base: Task, form: TaskForm): Omit<PatchTask, "revision"> {
	const patch: Omit<PatchTask, "revision"> = {};
	const prior = taskForm(base,form.date);
	if (form.dueDay!==prior.dueDay || form.dueTime!==prior.dueTime) {
		patch.due = !form.dueDay ? null : form.dueTime ?
			{type:"time",at:new Date(form.dueDay+"T"+form.dueTime).toISOString(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}
			: {type:"day",date:form.dueDay};
	}
	if (form.title.trim() !== base.title) patch.title = form.title.trim();
	if (form.taskKind !== base.kind) patch.kind = form.taskKind;
	if ((form.parent || null) !== base.parentId) patch.parentId = form.parent || null;
	const minutes = form.duration ? Number(form.duration) : null;
	if (minutes !== base.durationMinutes) patch.durationMinutes = minutes;
	const original = base.schedule;
	const iso = (value: string, prior?: string) =>
		prior && localTime(prior) === value ? prior : new Date(value).toISOString();
	let schedule: Task["schedule"] = null;
	if (form.type === "day") {
		schedule = { type: "day", date: form.date };
		if (original?.type === "day" && original.endDateExclusive) {
			const duration = Date.parse(original.endDateExclusive) - Date.parse(original.date);
			schedule.endDateExclusive = new Date(Date.parse(form.date) + duration).toISOString().slice(0, 10);
		}
	}
	if (form.type === "fixed" || form.type === "window") {
		const interval = original && original.type !== "day" ? original : undefined;
		schedule = {
			type: form.type,
			start: iso(form.start, interval?.start),
			end: iso(form.end, interval?.end),
		};
	}
	if (JSON.stringify(schedule) !== JSON.stringify(original)) patch.schedule = schedule;
	return patch;
}

export function prepareTaskEdit(base: Task, form: TaskForm, current: Task) {
	const fields = editedFields(base, form);
	for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
		const latest = JSON.stringify(current[key]);
		if (latest === JSON.stringify(fields[key])) {
			delete fields[key];
		} else if (current.revision !== base.revision && latest !== JSON.stringify(base[key])) {
			return { status: "conflict" } as const;
		}
	}
	return Object.keys(fields).length
		? ({ status: "ready", patch: { ...fields, revision: current.revision } } as const)
		: ({ status: "unchanged" } as const);
}
