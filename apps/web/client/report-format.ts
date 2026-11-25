import type { GoalHistory, GoalTarget } from "@2do/api/plugin-reports";
import { dayKey } from "./calendar.ts";

const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const amount = (value: number, unit: string) => decimal.format(value) + " " + unit;

export function targetLabel(target: GoalTarget, unit: string) {
	if (target.comparator === "between")
		return decimal.format(target.min) + "–" + amount(target.max, unit);
	return (target.comparator === "atLeast" ? "At least " : "At most ") + amount(target.value, unit);
}

export const outcomes = {
	met: "Met",
	missed: "Missed",
	unknown: "Unknown",
	inProgress: "In progress",
} as const;
export const monthRange = (date: Date) => ({
	from: dayKey(new Date(date.getFullYear(), date.getMonth(), 1)),
	to: dayKey(new Date(date.getFullYear(), date.getMonth() + 1, 1)),
});

export type CalendarGoal = { goal: GoalHistory["goal"]; entry: GoalHistory["days"][number] };

export function goalsByDay(history: GoalHistory[]) {
	const days = new Map<string, CalendarGoal[]>();
	for (const { goal, days: entries } of history) {
		for (const entry of entries) {
			const matches = days.get(entry.day) ?? [];
			matches.push({ goal, entry });
			days.set(entry.day, matches);
		}
	}
	return days;
}

export function shortDate(day: string) {
	return new Date(day + "T12:00:00").toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
