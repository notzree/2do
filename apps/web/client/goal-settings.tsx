import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
	goalTarget,
	reportingDay,
	reportingZone,
	type Goal,
	type GoalTarget,
	type MetricDefinition,
} from "@2do/api/plugin-reports";
import { Modal } from "./modal.tsx";
import {
	changeDailyGoal,
	createDailyGoal,
	goalsQuery,
	metricsQuery,
	reportKey,
	settingsKey,
	saveReportingZone,
	useReportSettings,
} from "./plugin-report-api.ts";
import { shortDate, targetLabel } from "./report-format.ts";
import "./plugin-reports.css";

function ZoneEditor({ initial }: { initial: string }) {
	const [zone, setZone] = useState(initial);
	const client = useQueryClient();
	const save = useMutation({
		mutationFn: async () => saveReportingZone(reportingZone.parse(zone.trim())),
		onSuccess: async (next) => {
			client.setQueryData(settingsKey, next);
			await Promise.all([
				client.invalidateQueries({ queryKey: ["planner", "details"] }),
				client.invalidateQueries({ queryKey: reportKey }),
			]);
		},
	});
	const [zones] = useState(() => Intl.supportedValuesOf?.("timeZone") ?? []);
	return (
		<form
			className="setting-row reporting-zone"
			onSubmit={(e) => {
				e.preventDefault();
				save.mutate();
			}}
		>
			<div>
				<h2>Reporting time zone</h2>
				<p>Sets the default date for new logs and the day boundary for new goals.</p>
			</div>
			<div>
				<div className="report-toolbar">
					<label>
						<span className="report-sr">Reporting time zone</span>
						<input
							required
							maxLength={128}
							value={zone}
							onChange={(e) => {
								setZone(e.target.value);
								save.reset();
							}}
							placeholder="America/Toronto"
							list="report-zones"
							autoComplete="off"
						/>
					</label>
					<datalist id="report-zones">
						<option value="UTC" />
						{zones.map((name) => (
							<option key={name} value={name} />
						))}
					</datalist>
					<button type="submit" disabled={zone.trim() === initial || save.isPending}>
						Save zone
					</button>
				</div>
				{save.error && (
					<p className="error" role="alert">
						{reportingZone.safeParse(zone.trim()).success
							? save.error.message
							: "Choose a valid IANA time zone."}
					</p>
				)}
			</div>
		</form>
	);
}

function targetValues(current?: GoalTarget | null) {
	if (!current) return { op: "atLeast" as const, minimum: "", maximum: "" };
	if (current.comparator === "between")
		return { op: current.comparator, minimum: String(current.min), maximum: String(current.max) };
	return { op: current.comparator, minimum: String(current.value), maximum: "" };
}

function TargetFields({
	op,
	unit,
	defaults,
}: {
	op: GoalTarget["comparator"] | "end";
	unit: string;
	defaults: ReturnType<typeof targetValues>;
}) {
	const [editedMinimum, setMinimum] = useState<string>();
	const minimum = editedMinimum ?? defaults.minimum;
	if (op === "end") return null;
	return (
		<div className="report-toolbar">
			<label>
				{op === "between" ? "Minimum" : "Target"} ({unit})
				<input
					name="minimum"
					required
					step="any"
					type="number"
					value={minimum}
					onChange={(e) => setMinimum(e.target.value)}
				/>
			</label>
			{op === "between" && (
				<label>
					Maximum ({unit})
					<input
						name="maximum"
						required
						type="number"
						step="any"
						min={minimum || undefined}
						defaultValue={defaults.maximum}
					/>
				</label>
			)}
		</div>
	);
}

function targetFromForm(form: FormData, op: GoalTarget["comparator"] | "end") {
	if (op === "end") return null;
	const value = Number(form.get("minimum"));
	return goalTarget.parse(
		op === "between"
			? { comparator: op, min: value, max: Number(form.get("maximum")) }
			: { comparator: op, value },
	);
}

function GoalEditor({
	goal,
	metrics,
	zone,
	close,
}: {
	goal?: Goal;
	metrics: MetricDefinition[];
	zone: string;
	close: () => void;
}) {
	const latest = goal?.versions.at(-1);
	const defaults = targetValues(latest?.target);
	const [metricId, setMetricId] = useState(goal?.metric.id ?? metrics[0].id);
	const metric = goal?.metric ?? metrics.find((m) => m.id === metricId) ?? metrics[0];
	const today = reportingDay(goal?.timeZone ?? zone);
	const [start, setStart] = useState(
		latest && latest.effectiveFrom > today ? latest.effectiveFrom : today,
	);
	const [op, setOp] = useState<GoalTarget["comparator"] | "end">(defaults.op);
	const [id] = useState(() => crypto.randomUUID());
	const client = useQueryClient();
	const save = useMutation({
		mutationFn: async (form: FormData) => {
			const target = targetFromForm(form, op);
			if (goal)
				return changeDailyGoal(goal.id, { revision: goal.revision, effectiveFrom: start, target });
			if (!target) throw new Error("Choose a target.");
			return createDailyGoal({
				id,
				metricId: metric.id,
				label: String(form.get("label")).trim() || metric.label,
				effectiveFrom: start,
				target,
			});
		},
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: reportKey });
			close();
		},
		onError: () => client.invalidateQueries({ queryKey: goalsQuery.queryKey }),
	});
	function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		save.mutate(new FormData(e.currentTarget));
	}
	return (
		<Modal title={goal ? "Edit daily goal" : "New daily goal"} close={close}>
			<form onSubmit={submit} className="report-form">
				<label>
					Metric
					<select value={metricId} onChange={(e) => setMetricId(e.target.value)} disabled={!!goal}>
						{metrics.map((m) => (
							<option key={m.id} value={m.id}>
								{m.label} ({m.unit})
							</option>
						))}
					</select>
				</label>
				{goal ? (
					<strong>{goal.label}</strong>
				) : (
					<label>
						Goal name
						<input maxLength={120} name="label" placeholder={metric.label} />
					</label>
				)}
				<label>
					Daily target
					<select value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
						<option value="atLeast">At least</option>
						<option value="atMost">At most</option>
						<option value="between">Between</option>
						{goal && <option value="end">End goal</option>}
					</select>
				</label>
				<TargetFields op={op} unit={metric.unit} defaults={defaults} />
				<label>
					{op === "end" ? "First inactive day" : "Effective from"}
					<input
						type="date"
						required
						min={goal?.versions[0].effectiveFrom}
						value={start}
						onChange={(e) => setStart(e.target.value)}
					/>
				</label>
				{op === "end" && goal?.versions.some((v) => v.effectiveFrom >= start && v.target) && (
					<p>Ending this goal removes scheduled targets from this date onward.</p>
				)}
				{save.error && (
					<p role="alert" className="error">
						{save.error.message}
					</p>
				)}
				<button className="primary" type="submit" disabled={save.isPending}>
					{op === "end" ? "End goal" : "Save goal"}
				</button>
			</form>
		</Modal>
	);
}

function GoalList({ goals, edit }: { goals: Goal[]; edit: (goal: Goal) => void }) {
	if (!goals.length) return <p>Set a daily target to track it on your calendar.</p>;
	return (
		<ul className="goal-list">
			{goals.map((goal) => {
				const latest = goal.versions[goal.versions.length - 1];
				return (
					<li key={goal.id}>
						<div>
							<strong>{goal.label}</strong>
							<p>
								{latest.target ? targetLabel(latest.target, goal.metric.unit) : "Inactive"} · From{" "}
								{shortDate(latest.effectiveFrom)}
							</p>
							{goal.versions.length > 1 && (
								<details>
									<summary>Target history</summary>
									<ol>
										{goal.versions.map((v) => (
											<li key={v.effectiveFrom}>
												{shortDate(v.effectiveFrom)} ·{" "}
												{v.target ? targetLabel(v.target, goal.metric.unit) : "Inactive"}
											</li>
										))}
									</ol>
								</details>
							)}
						</div>
						<button aria-label={"Edit " + goal.label} onClick={() => edit(goal)}>
							Edit
						</button>
					</li>
				);
			})}
		</ul>
	);
}

export function GoalSettings({ openPlugins }: { openPlugins: () => void }) {
	const settings = useReportSettings();
	const metrics = useQuery(metricsQuery);
	const goals = useQuery(goalsQuery);
	const [editing, setEditing] = useState<Goal | "create" | null>(null);
	const error = settings.error ?? metrics.error ?? goals.error;
	if (error)
		return (
			<p role="alert" className="error">
				{error.message}{" "}
				<button
					onClick={() => {
						void settings.refetch();
						void metrics.refetch();
						void goals.refetch();
					}}
				>
					Retry
				</button>
			</p>
		);
	const zone = settings.data?.timeZone;
	if (!zone || !metrics.data || !goals.data) return <p role="status">Loading goals…</p>;
	const available = metrics.data.length > 0;
	return (
		<>
			<ZoneEditor key={zone} initial={zone} />
			<section className="goal-settings">
				<div className="section-head">
					<h2>Daily goals</h2>
					{available && (
						<button type="button" onClick={() => setEditing("create")}>
							New goal
						</button>
					)}
				</div>
				{available ? (
					<GoalList goals={goals.data} edit={setEditing} />
				) : (
					<p>
						Enable a plugin with metrics to create a daily goal.{" "}
						<button onClick={openPlugins}>Open plugins</button>
					</p>
				)}
			</section>
			{editing && available && (
				<GoalEditor
					goal={editing === "create" ? undefined : editing}
					metrics={metrics.data}
					zone={zone}
					close={() => setEditing(null)}
				/>
			)}
		</>
	);
}
