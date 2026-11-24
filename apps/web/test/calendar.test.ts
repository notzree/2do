import { expect, it } from "vite-plus/test";
import { task } from "@2do/api/plan";
import { dayKey, monthDays, onDay, weekDays } from "../client/calendar.ts";

it("renders a whole Sunday-first month including adjacent years", () => {
  const days = monthDays(new Date(2027, 0, 10));
  expect(days[0].getDay()).toBe(0);
  expect(dayKey(days[0])).toBe("2026-12-27");
  expect(dayKey(days.at(-1)!)).toBe("2027-02-06");
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
