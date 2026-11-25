import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
	nextReportDay,
	reportRange,
	type GoalHistory,
	type MetricSeries,
} from "@2do/api/plugin-reports";
import { dayKey, offsetDay, type WeekStart } from "./calendar.ts";
import { historyQuery, metricsQuery, seriesQuery, type Bucket } from "./plugin-report-api.ts";
import {
	amount,
	monthRange,
	outcomes,
	shortDate,
	targetLabel,
	type CalendarGoal,
} from "./report-format.ts";
import "./plugin-reports.css";

const exclusiveDay = (inclusive: string) =>
	/^\d{4}-\d{2}-\d{2}$/.test(inclusive) && Number.isFinite(Date.parse(inclusive))
		? nextReportDay(inclusive)
		: "";
const lastDay = (exclusive: string) => dayKey(offsetDay(new Date(exclusive + "T12:00:00"), -1));

export function SeriesTable({ series }: { series: MetricSeries }) {
	return (
		<div
			className="metric-table-wrap"
			role="region"
			aria-label={series.metric.label + " data"}
			tabIndex={0}
		>
			<table className="metric-table">
				<caption className="report-sr">
					{series.metric.label} totals and observation coverage
				</caption>
				<thead>
					<tr>
						<th scope="col">Period</th>
						<th scope="col">Logged total ({series.metric.unit})</th>
						<th scope="col">Known entries</th>
						<th scope="col">Missing values</th>
					</tr>
				</thead>
				<tbody>
					{series.buckets.map((b) => {
						const end = lastDay(b.to);
						return (
							<tr key={b.from}>
								<th scope="row">
									{shortDate(b.from)}
									{end !== b.from && " – " + shortDate(end)}
								</th>
								<td>
									{b.value === null
										? "Unknown"
										: b.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
								</td>
								<td>{b.known}</td>
								<td>{b.unknown}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

export function DailyGoalDetails({
	entries,
	day,
	manage,
}: {
	entries: CalendarGoal[];
	day: string;
	manage: () => void;
}) {
	return (
		<section className="goal-day" aria-label={"Daily goals for " + day}>
			<div className="section-head">
				<h2>Goals for {shortDate(day)}</h2>
				<button onClick={manage}>Manage goals</button>
			</div>
			{entries.length === 0 ? (
				<p className="muted">No goals to assess for this date.</p>
			) : (
				<ul className="goal-list">
					{entries.map(({ goal, entry }) => (
						<li key={goal.id}>
							<div>
								<strong>{goal.label}</strong>
								<p>
									{targetLabel(entry.target, goal.metric.unit)}
									{" · "}
									{entry.value === null
										? "No known value"
										: amount(entry.value, goal.metric.unit) + " logged"}
									{entry.unknown > 0 &&
										" · " +
											entry.unknown +
											" missing " +
											(entry.unknown === 1 ? "value" : "values")}
								</p>
							</div>
							<span className="goal-outcome" data-status={entry.outcome}>
								{outcomes[entry.outcome]}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function GoalCounts({ history }: { history: GoalHistory[] }) {
	if (!history.length) return <p className="muted">No active goals in this period.</p>;
	return (
		<ul className="goal-list">
			{history.map(({ goal, counts }) => {
				const elapsed = counts.met + counts.missed + counts.unknown;
				return (
					<li key={goal.id}>
						<div>
							<strong>{goal.label}</strong>
							<p>
								{counts.met} of {elapsed} elapsed {elapsed === 1 ? "day" : "days"} met
								{" · "}
								{counts.missed} missed · {counts.unknown} unknown
								{counts.inProgress > 0 && " · " + counts.inProgress + " in progress"}
							</p>
						</div>
					</li>
				);
			})}
		</ul>
	);
}

function ReportPeriod({
	metricId,
	from,
	to,
	bucket,
	weekStart,
}: {
	metricId: string;
	from: string;
	to: string;
	bucket: Bucket;
	weekStart: WeekStart;
}) {
	const series = useQuery(seriesQuery(metricId, from, to, bucket, weekStart));
	const history = useQuery(historyQuery(from, to));
	return (
		<>
			{series.error && (
				<p className="error" role="alert">
					{series.error.message} <button onClick={() => void series.refetch()}>Retry totals</button>
				</p>
			)}
			{series.isPending && <p role="status">Loading totals…</p>}
			{series.data && <SeriesTable series={series.data} />}
			<h3>Daily goal history</h3>
			{history.error && (
				<p className="error" role="alert">
					{history.error.message}{" "}
					<button onClick={() => void history.refetch()}>Retry history</button>
				</p>
			)}
			{history.isPending && <p role="status">Loading goals…</p>}
			{history.data && <GoalCounts history={history.data} />}
		</>
	);
}

export function PluginReports({
	date,
	weekStart,
	manage,
	openPlugins,
}: {
	date: Date;
	weekStart: WeekStart;
	manage: () => void;
	openPlugins: () => void;
}) {
	const initial = monthRange(date);
	const [from, setFrom] = useState(initial.from);
	const [through, setThrough] = useState(() => lastDay(initial.to));
	const [bucket, setBucket] = useState<Bucket>("day");
	const [selection, setSelection] = useState("");
	const metrics = useQuery(metricsQuery);
	const metric = metrics.data?.find((m) => m.id === selection) ?? metrics.data?.[0];
	const to = exclusiveDay(through);
	const valid = reportRange.safeParse({ from, to }).success;
	return (
		<section className="metric-reports" aria-label="Plugin reports">
			<div className="section-head">
				<h2>Reports</h2>
				<button onClick={manage}>Manage goals</button>
			</div>
			{metrics.error && (
				<p role="alert" className="error">
					{metrics.error.message} <button onClick={() => void metrics.refetch()}>Retry</button>
				</p>
			)}
			{metrics.isPending && <p role="status">Loading metrics…</p>}
			{metrics.data?.length === 0 && (
				<p>
					Enable a plugin with metrics to view reports.{" "}
					<button onClick={openPlugins}>Open plugins</button>
				</p>
			)}
			{metric && (
				<>
					<div className="report-toolbar">
						<label>
							Metric
							<select value={metric.id} onChange={(e) => setSelection(e.target.value)}>
								{metrics.data?.map((m) => (
									<option key={m.id} value={m.id}>
										{m.label} ({m.unit})
									</option>
								))}
							</select>
						</label>
						<label>
							From
							<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
						</label>
						<label>
							Through
							<input type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
						</label>
						<label>
							Group by
							<select value={bucket} onChange={(e) => setBucket(e.target.value as Bucket)}>
								<option value="day">Day</option>
								<option value="week">Week</option>
								<option value="month">Month</option>
							</select>
						</label>
					</div>
					{!valid && (
						<p className="error" role="alert">
							Choose up to 366 days, with the end on or after the start.
						</p>
					)}
					{valid && (
						<ReportPeriod
							metricId={metric.id}
							from={from}
							to={to}
							bucket={bucket}
							weekStart={weekStart}
						/>
					)}
				</>
			)}
		</section>
	);
}
