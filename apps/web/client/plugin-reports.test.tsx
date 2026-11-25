import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { GoalHistory, MetricDefinition, MetricSeries } from "@2do/api/plugin-reports";
import { GoalSettings } from "./goal-settings.tsx";
import { MonthCalendar } from "./month-calendar.tsx";
import { DailyGoalDetails, PluginReports, SeriesTable } from "./plugin-reports.tsx";
import { goalsQuery, historyQuery, metricsQuery, seriesQuery } from "./plugin-report-api.ts";
import { goalsByDay, monthRange } from "./report-format.ts";

const study: MetricDefinition = {
	id: "study.minutes",
	label: "Study time",
	unit: "min",
	version: 1,
	reducer: "sum",
};
const target = { comparator: "atLeast", value: 60 } as const;
const history: GoalHistory = {
	goal: {
		id: crypto.randomUUID(),
		label: "Daily study",
		metric: study,
		timeZone: "America/Toronto",
		revision: crypto.randomUUID(),
		versions: [{ effectiveFrom: "2026-10-31", target }],
	},
	counts: { met: 1, missed: 1, unknown: 1, inProgress: 0 },
	days: [
		{ day: "2026-11-01", value: 65, known: 2, unknown: 0, target, outcome: "met" },
		{ day: "2026-11-02", value: 0, known: 1, unknown: 0, target, outcome: "missed" },
		{ day: "2026-11-03", value: 32, known: 1, unknown: 1, target, outcome: "unknown" },
	],
};
const series: MetricSeries = {
	metric: study,
	buckets: [
		{ from: "2026-11-01", to: "2026-11-02", value: 0, known: 1, unknown: 0 },
		{ from: "2026-11-02", to: "2026-11-03", value: null, known: 0, unknown: 1 },
	],
};

it("groups two independent goals on one calendar day and keeps missing coverage visible", () => {
	const other = {
		...history,
		goal: { ...history.goal, id: crypto.randomUUID(), label: "Practice daily" },
	};
	const day = "2026-11-03";
	const entries = goalsByDay([history, other]).get(day)!;
	const html = renderToStaticMarkup(
		<DailyGoalDetails day={day} entries={entries} manage={() => {}} />,
	);
	expect(html).toContain("Daily study");
	expect(html).toContain("Practice daily");
	expect(html).toContain("32 min logged");
	expect(html).toContain("1 missing value");
	expect(html).toContain("Unknown");
});

it("preserves a measured zero and distinguishes it from a bucket with no known value", () => {
	const html = renderToStaticMarkup(<SeriesTable series={series} />);
	expect(html).toContain("Logged total (min)");
	expect(html).toContain("<td>0</td><td>1</td><td>0</td>");
	expect(html).toContain("<td>Unknown</td><td>0</td><td>1</td>");
});

it("connects monthly goal counts and a selected day's actual target to the calendar", () => {
	const client = new QueryClient();
	const date = new Date(2026, 10, 2);
	const range = monthRange(date);
	expect(range).toEqual({ from: "2026-11-01", to: "2026-12-01" });
	client.setQueryData(historyQuery(range.from, range.to).queryKey, [history]);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MonthCalendar
				date={date}
				weekStart={1}
				tasks={[]}
				open={() => {}}
				select={() => {}}
				openWeek={() => {}}
				openSettings={() => {}}
			/>
		</QueryClientProvider>,
	);
	expect(html).toContain("1/1 goals met");
	expect(html).toContain("Goals unknown");
	expect(html).toContain("0 min logged");
	expect(html).toContain("Missed");
	expect(html).toContain("At least 60 min");
});

it("renders generic goal editing and reports from the enabled metric catalog", () => {
	const client = new QueryClient();
	const from = "2026-11-01",
		to = "2026-12-01";
	client.setQueryData(metricsQuery.queryKey, [study]);
	client.setQueryData(goalsQuery.queryKey, [history.goal]);
	client.setQueryData(["planner", "report-settings"], { timeZone: "America/Toronto" });
	client.setQueryData(historyQuery(from, to).queryKey, [history]);
	client.setQueryData(seriesQuery(study.id, from, to, "day", 1).queryKey, series);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<GoalSettings openPlugins={() => {}} />
			<PluginReports
				date={new Date(2026, 10, 2)}
				weekStart={1}
				manage={() => {}}
				openPlugins={() => {}}
			/>
		</QueryClientProvider>,
	);
	expect(html).toContain("Reporting time zone");
	expect(html).toContain("Edit Daily study");
	expect(html).toContain("Study time (min)");
	expect(html).toContain("1 of 3 elapsed days met");
	expect(html).toContain("1 missed · 1 unknown");
});
