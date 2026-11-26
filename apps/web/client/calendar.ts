import type { Task } from "@2do/api/plan";

export type WeekStart = 0 | 1;

export function dayKey(date: Date) {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}
export function isCarryoverShadow(task: Task, date: string) {
	return task.currentDay !== date && !!task.carriedFrom?.includes(date);
}
export function carryoverShadowLabel(task: Task, date: string) {
	return [task.title, dueDay(task) === date && dueLabel(task), "Moved to " + (task.currentDay ?? "backlog")]
		.filter(Boolean).join(" · ");
}
export function onDay(task: Task, day: Date) {
	const date = dayKey(day);
	if (dueDay(task) === date || (!task.schedule && task.currentDay === date)) return true;
	return !isCarryoverShadow(task, date) && scheduledOnDay(task, day);
}
export function scheduledOnDay(task:Task,day:Date) {
	const s=task.schedule;
	if (!s) return false;
	if (s.type === "day") {
		const key = dayKey(day);
		return s.endDateExclusive ? s.date <= key && key < s.endDateExclusive : s.date === key;
	}
	const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
	const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
	return Date.parse(s.start) < +next && Date.parse(s.end) > +start;
}
function monthOffset(date: Date, weekStart: WeekStart) {
	const first = new Date(date.getFullYear(), date.getMonth(), 1);
	return (first.getDay() - weekStart + 7) % 7;
}
export function weekOfMonth(date: Date, weekStart: WeekStart) {
	return 1 + Math.floor((monthOffset(date, weekStart) + date.getDate() - 1) / 7);
}
export function monthDays(date: Date, weekStart: WeekStart = 0) {
	const year = date.getFullYear(),
		month = date.getMonth();
	const offset = monthOffset(date, weekStart);
	const count = new Date(year, month + 1, 0).getDate();
	return Array.from(
		{ length: Math.ceil((count + offset) / 7) * 7 },
		(_, i) => new Date(year, month, 1 - offset + i),
	);
}

export const views = ["week", "calendar"] as const;
export type View = (typeof views)[number];
export const formatDate = (date: Date, options: Intl.DateTimeFormatOptions) =>
	date.toLocaleDateString(undefined, options);
export const fullDate = (date: Date) =>
	formatDate(date, { weekday: "long", month: "long", day: "numeric" });
export function offsetDay(date: Date, offset: number) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
}
export const nextPeriods = {
	nextDay: "Next day",
	nextWeek: "Next week",
	nextMonth: "Next month",
} as const;
export type NextPeriod = keyof typeof nextPeriods;
export const previousPeriods = {
	previousDay: "Previous day",
	previousWeek: "Previous week",
	previousMonth: "Previous month",
} as const;
export type PreviousPeriod = keyof typeof previousPeriods;
export function nextDate(date: Date, period: NextPeriod) {
	if (period !== "nextMonth") return offsetDay(date, period === "nextWeek" ? 7 : 1);
	const lastDay = new Date(date.getFullYear(), date.getMonth() + 2, 0);
	return new Date(lastDay.getFullYear(), lastDay.getMonth(), Math.min(date.getDate(), lastDay.getDate()));
}
export function previousDate(date: Date, period: PreviousPeriod) {
	if (period === "previousDay") return offsetDay(date, -1);
	if (period === "previousWeek") return offsetDay(date, -7);
	const lastDay = new Date(date.getFullYear(), date.getMonth(), 0);
	return new Date(lastDay.getFullYear(), lastDay.getMonth(), Math.min(date.getDate(), lastDay.getDate()));
}
export function startOfWeek(date: Date, weekStart: WeekStart = 0) {
	return offsetDay(date, -((date.getDay() - weekStart + 7) % 7));
}
export function weekDays(date: Date, weekStart: WeekStart = 0) {
	const start = startOfWeek(date, weekStart);
	return Array.from({ length: 7 }, (_, i) => offsetDay(start, i));
}
export function timeRange(task: Task) {
	const s = task.schedule;
	if (!s || s.type === "day") return "";
	const start = new Date(s.start),
		end = new Date(s.end);
	const fmt = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	const endLabel =
		dayKey(start) === dayKey(end)
			? fmt(end)
			: formatDate(end, { month: "short", day: "numeric" }) + " " + fmt(end);
	return (s.type === "window" ? "Available " : "") + fmt(start) + "–" + endLabel;
}

/** Chronological start in local time, including date-only entries at local midnight. */
export function scheduleStart(schedule: NonNullable<Task["schedule"]>) {
	return new Date(schedule.type === "day" ? schedule.date + "T00:00:00" : schedule.start);
}

export function dueDay(task:Task) {
	return task.due?.type==="day"?task.due.date:task.due?.type==="time"?dayKey(new Date(task.due.at)):undefined;
}
export function dueLabel(task:Task) {
	const due=task.due;
	if (!due) return "";
	const timed=due.type==="time";
	const overdue=!task.completed && (timed ? Date.parse(due.at)<Date.now() : due.date<dayKey(new Date()));
	return (overdue?"Overdue · ":"Due ")+(timed?new Date(due.at).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):due.date);
}
