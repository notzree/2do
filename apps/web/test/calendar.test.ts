import { expect, it } from "vite-plus/test";
import { task } from "@2do/api/plan";
import { carryoverShadowLabel, dayKey, dueLabel, monthDays, nextDate, onDay, previousDate, weekDays, weekOfMonth } from "../client/calendar.ts";

it.each([
  ["2026-12-31", "nextDay", "2027-01-01"],
  ["2026-12-31", "nextWeek", "2027-01-07"],
  ["2026-12-31", "nextMonth", "2027-01-31"],
  ["2027-01-31", "nextMonth", "2027-02-28"],
  ["2028-01-31", "nextMonth", "2028-02-29"],
] as const)("moves from %s by %s to %s", (start, unit, expected) => {
  expect(dayKey(nextDate(new Date(start + "T00:00:00"), unit))).toBe(expected);
});

it.each([
  ["2027-01-01", "previousDay", "2026-12-31"],
  ["2027-01-01", "previousWeek", "2026-12-25"],
  ["2027-03-31", "previousMonth", "2027-02-28"],
  ["2028-03-31", "previousMonth", "2028-02-29"],
] as const)("moves from %s by %s to %s", (start, unit, expected) => {
  expect(dayKey(previousDate(new Date(start + "T00:00:00"), unit))).toBe(expected);
});

it("renders a whole Sunday-first month including adjacent years", () => {
  const days = monthDays(new Date(2027, 0, 10));
  expect(days[0].getDay()).toBe(0);
  expect(dayKey(days[0])).toBe("2026-12-27");
  expect(dayKey(days.at(-1)!)).toBe("2027-02-06");
});

it.each([
  { type: "day", date: "2027-01-31" },
  { type: "time", at: new Date(2027, 0, 31, 23, 30).toISOString(), timeZone: "UTC" },
] as const)("keeps a $type deadline visible after two carryovers", (due) => {
  const item = task.parse({
    id: crypto.randomUUID(), title: "Submit report", kind: "task", revision: 3,
    completed: false, durationMinutes: null, parentId: null, due,
    carriedFrom: ["2027-01-31", "2027-02-01"], currentDay: "2027-02-02",
    schedule: { type: "day", date: "2027-02-02" },
  });
  const days = [new Date(2027, 0, 31), new Date(2027, 1, 1), new Date(2027, 1, 2)];
  expect(days.map(day => onDay(item, day))).toEqual([true, false, true]);
  expect(carryoverShadowLabel(item, "2027-01-31")).toContain(dueLabel(item));
  expect(carryoverShadowLabel(item, "2027-02-01")).toBe("Submit report · Moved to 2027-02-02");
});

it.each([
  ["2026-11-01", 1, 1],
  ["2026-11-02", 1, 2],
  ["2026-11-24", 4, 5],
  ["2026-11-30", 5, 6],
  ["2026-12-01", 1, 1],
] as const)("numbers %s within its own month for either week start", (key, sunday, monday) => {
  const date = new Date(key + "T00:00:00");
  expect(weekOfMonth(date, 0)).toBe(sunday);
  expect(weekOfMonth(date, 1)).toBe(monday);
});

it("shows the selected date's full Sunday-to-Saturday week", () => {
  const days = weekDays(new Date(2026, 10, 23));
  expect(days.map(dayKey)).toEqual([
    "2026-11-22",
    "2026-11-23",
    "2026-11-24",
    "2026-11-25",
    "2026-11-26",
    "2026-11-27",
    "2026-11-28",
  ]);
});

it("shows overnight activities on both days and treats the end as exclusive", () => {
  const item = task.parse({
    id: crypto.randomUUID(),
    title: "Travel",
    revision: 1,
    parentId: null,
    kind: "event",
    completed: false,
    durationMinutes: null,
    schedule: {
      type: "fixed",
      start: new Date(2026, 10, 21, 23).toISOString(),
      end: new Date(2026, 10, 23).toISOString(),
    },
  });
  expect([21, 22, 23].map((day) => onDay(item, new Date(2026, 10, day)))).toEqual([
    true,
    true,
    false,
  ]);
});

it("keeps a Sunday in the preceding Monday-first week and aligns the month grid", () => {
  const sunday = new Date(2027, 0, 3);
  expect(weekDays(sunday, 1).map(dayKey)).toEqual([
    "2026-12-28",
    "2026-12-29",
    "2026-12-30",
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
    "2027-01-03",
  ]);
  const month = monthDays(sunday, 1);
  expect(dayKey(month[0])).toBe("2026-12-28");
  expect(dayKey(month.at(-1)!)).toBe("2027-01-31");
});
