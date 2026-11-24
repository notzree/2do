import type { Task } from "@2do/api/plan";

export type WeekStart = 0 | 1;

export function dayKey(date: Date) {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}
export function onDay(task: Task, day: Date) {
	const s = task.schedule;
	if (!s) return false;
	if (s.type === "day") return s.date === dayKey(day);
	const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
	const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
	return Date.parse(s.start) < +next && Date.parse(s.end) > +start;
}
export function monthDays(date: Date, weekStart: WeekStart = 0) {
	const year = date.getFullYear(),
		month = date.getMonth();
	const offset = (new Date(year, month, 1).getDay() - weekStart + 7) % 7;
	const count = new Date(year, month + 1, 0).getDate();
	return Array.from(
		{ length: Math.ceil((count + offset) / 7) * 7 },
		(_, i) => new Date(year, month, 1 - offset + i),
	);
}

export const views = ["day", "week", "calendar"] as const;
export type View = (typeof views)[number];
export const formatDate = (date: Date, options: Intl.DateTimeFormatOptions) =>
	date.toLocaleDateString(undefined, options);
export const fullDate = (date: Date) =>
	formatDate(date, { weekday: "long", month: "long", day: "numeric" });
export function offsetDay(date: Date, offset: number) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
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
