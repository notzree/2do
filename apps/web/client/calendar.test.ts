import { expect, it } from "vite-plus/test";
import type { Task } from "@2do/api/plan";
import { onDay } from "./calendar.ts";

it("projects timed events by local overlap even when their stored day differs", () => {
	const day = new Date(2026, 10, 26, 20);
	const nextDay = new Date(2026, 10, 27);
	const event: Task = {
		id: crypto.randomUUID(),
		title: "Evening event",
		kind: "event",
		parentId: null,
		completed: false,
		revision: 1,
		durationMinutes: null,
		currentDay: "2026-11-27",
		schedule: {
			type: "fixed",
			start: day.toISOString(),
			end: new Date(+day + 3600_000).toISOString(),
		},
	};
	expect(onDay(event, day)).toBe(true);
	expect(onDay(event, nextDay)).toBe(false);
	expect(onDay({ ...event, schedule: null }, nextDay)).toBe(true);
});
