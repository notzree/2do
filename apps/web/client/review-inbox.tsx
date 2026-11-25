import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, Check, Inbox, Undo2, X } from "lucide-react";
import type { Task } from "@2do/api/plan";
import type { components } from "./openapi.d.ts";
import { api, queryClient } from "./query.ts";
import { localTime } from "./task-edits.ts";
import "./review-inbox.css";

const reviewKey = ["planner", "review"] as const;
function usePendingReview() {
	return useQuery({
		queryKey: reviewKey,
		queryFn: async ({ signal }) => {
			const result = await api.GET("/api/review", { signal });
			return result.data ?? [];
		},
	});
}
export function useReviewInbox() {
	const query = usePendingReview();
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	return {
		pendingCount: query.data?.length ?? 0,
		open,
		show: () => setOpen(true),
		close,
	};
}

export function ProposeTime({ task }: { task: Task }) {
	const [draft, setDraft] = useState<{
		start: string;
		end: string;
		reason: string;
		revision: number;
		id: string;
	}>();
	const save = useMutation({
		mutationFn: async (input: NonNullable<typeof draft>) =>
			api.POST("/api/review", {
				body: {
					id: input.id,
					revision: input.revision,
					taskId: task.id,
					reason: input.reason.trim() || "Proposed time change",
					after: {
						type: "fixed",
						start: new Date(input.start).toISOString(),
						end: new Date(input.end).toISOString(),
					},
				},
			}),
		onSuccess: () => {
			setDraft(undefined);
			void queryClient.invalidateQueries({ queryKey: reviewKey });
		},
	});
	const schedule = task.schedule;
	if (schedule?.type !== "fixed" || task.completed) return null;
	function edit(patch: Partial<NonNullable<typeof draft>>) {
		setDraft((current) => current && { ...current, ...patch, id: crypto.randomUUID() });
		save.reset();
	}
	const valid =
		draft &&
		Date.parse(draft.end) > Date.parse(draft.start) &&
		(draft.start !== localTime(schedule.start) || draft.end !== localTime(schedule.end));
	return (
		<section className="propose-time">
			{!draft ? (
				<button
					type="button"
					onClick={() => {
						save.reset();
						setDraft({
							id: crypto.randomUUID(),
							revision: task.revision,
							reason: "",
							start: localTime(schedule.start),
							end: localTime(schedule.end),
						});
					}}
				>
					<CalendarClock size={14} /> Propose new time
				</button>
			) : (
				<form
					className="editor"
					onSubmit={(e) => {
						e.preventDefault();
						if (valid) save.mutate(draft);
					}}
				>
					<label>
						Proposed start
						<input
							type="datetime-local"
							required
							value={draft.start}
							onChange={(e) => {
								const start = e.target.value;
								const duration = Date.parse(draft.end) - Date.parse(draft.start);
								edit(
									Number.isFinite(Date.parse(start)) && duration > 0
										? {
												start,
												end: localTime(new Date(Date.parse(start) + duration).toISOString()),
											}
										: { start },
								);
							}}
						/>
					</label>
					<label>
						Proposed end
						<input
							type="datetime-local"
							required
							min={draft.start}
							value={draft.end}
							onChange={(e) => edit({ end: e.target.value })}
						/>
					</label>
					<label>
						Reason (optional)
						<input
							maxLength={500}
							value={draft.reason}
							onChange={(e) => edit({ reason: e.target.value })}
						/>
					</label>
					<div className="actions">
						<button type="submit" disabled={!valid || save.isPending}>
							Send to Review
						</button>
						<button type="button" disabled={save.isPending} onClick={() => setDraft(undefined)}>
							Cancel
						</button>
					</div>
				</form>
			)}
			{save.isSuccess && (
				<small role="status">
					{save.data.data?.status === "pending"
						? "Added to Review"
						: "This proposal has already been reviewed."}
				</small>
			)}
			{save.isError && <small role="alert">{save.error.message}</small>}
		</section>
	);
}

type Proposal = components["schemas"]["TimeProposal"] & { title: string };
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
function interval({ start, end }: Proposal["before"]) {
	return dateTime.formatRange(new Date(start), new Date(end));
}
function ProposalCard({
	proposal,
	onDecided,
}: {
	proposal: Proposal;
	onDecided: (message: string) => void;
}) {
	const decide = useMutation({
		mutationFn: (decision: "accept" | "reject") =>
			api.POST("/api/review/{id}/decision", {
				params: { path: { id: proposal.id } },
				body: { decision },
			}),
		onSuccess: (_, decision) => {
			onDecided(
				decision === "accept"
					? "Time updated. Undo is available in Recent decisions."
					: "Proposal rejected.",
			);
			return queryClient.invalidateQueries({ queryKey: ["planner"] });
		},
	});
	return (
		<article className="proposal-card">
			<header>
				<CalendarClock size={15} />
				<strong>{proposal.title}</strong>
				<small>{proposal.source === "copilot" ? "Copilot" : "Calendar"}</small>
			</header>
			<p>{proposal.reason}</p>
			<div className="proposal-diff">
				<div aria-label="Current time">
					<span aria-hidden="true">−</span> {interval(proposal.before)}
				</div>
				<div aria-label="Proposed time">
					<span aria-hidden="true">+</span> {interval(proposal.after)}
				</div>
			</div>
			<div className="actions">
				<button
					className="primary"
					disabled={decide.isPending}
					onClick={() => decide.mutate("accept")}
				>
					<Check size={14} /> Accept change
				</button>
				<button disabled={decide.isPending} onClick={() => decide.mutate("reject")}>
					Reject
				</button>
			</div>
			{decide.isError && <p role="alert">{decide.error.message}</p>}
		</article>
	);
}

function RecentDecision({
	proposal,
	onUndo,
}: {
	proposal: Proposal & { canUndo: boolean };
	onUndo: () => void;
}) {
	const undo = useMutation({
		mutationFn: () => api.POST("/api/review/{id}/undo", { params: { path: { id: proposal.id } } }),
		onSuccess: onUndo,
		onSettled: () => queryClient.invalidateQueries({ queryKey: ["planner"] }),
	});
	return (
		<li className="recent-decision">
			<div>
				<strong>{proposal.title}</strong> <small>{proposal.status}</small>
			</div>
			<p>
				{interval(proposal.before)} → {interval(proposal.after)}
			</p>
			{proposal.status === "accepted" &&
				(proposal.canUndo ? (
					<button type="button" onClick={() => undo.mutate()} disabled={undo.isPending}>
						<Undo2 size={14} aria-hidden="true" /> Undo time change
					</button>
				) : (
					<small>
						{proposal.acceptedRevision === undefined
							? "Applied revision unavailable."
							: "Task edited since acceptance."}
					</small>
				))}
			{undo.isError && <p role="alert">{undo.error.message}</p>}
		</li>
	);
}

function RecentDecisions({ onUndo }: { onUndo: () => void }) {
	const [open, setOpen] = useState(false);
	const query = useQuery({
		queryKey: [...reviewKey, "recent"],
		queryFn: async ({ signal }) => (await api.GET("/api/review/recent", { signal })).data ?? [],
		enabled: open,
	});
	return (
		<details className="review-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>Recent decisions</summary>
			{open &&
				(query.isError ? (
					<p role="alert">
						{query.error.message} <button onClick={() => void query.refetch()}>Retry</button>
					</p>
				) : query.isPending ? (
					<p role="status">Loading decisions…</p>
				) : query.data.length ? (
					<ul>
						{query.data.map((p) => (
							<RecentDecision key={p.id} proposal={p} onUndo={onUndo} />
						))}
					</ul>
				) : (
					<p>No decisions yet.</p>
				))}
		</details>
	);
}

export function ReviewPanel({ close }: { close: () => void }) {
	const ref = useRef<HTMLElement>(null);
	const [receipt, setReceipt] = useState("");
	const query = usePendingReview();
	useEffect(() => {
		ref.current?.focus({ preventScroll: true });
	}, []);
	return (
		<aside
			ref={ref}
			className="review-panel"
			aria-label="Review inbox"
			tabIndex={-1}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					close();
				}
			}}
		>
			<header className="review-panel-head">
				<Inbox size={16} /> Review inbox
				<button type="button" className="plain" aria-label="Close Review" onClick={close}>
					<X size={17} />
				</button>
			</header>
			<div className="review-panel-body">
				<h2>Review</h2>
				{receipt && <p role="status">{receipt}</p>}
				{query.isError ? (
					<p role="alert">
						{query.error.message} <button onClick={() => void query.refetch()}>Retry</button>
					</p>
				) : query.isPending ? (
					<p role="status">Loading proposals…</p>
				) : query.data?.length ? (
					<>
						<p>
							{query.data.length} pending {query.data.length === 1 ? "proposal" : "proposals"}
						</p>
						<h3>Needs a decision</h3>
						{query.data.map((p) => (
							<ProposalCard key={p.id} proposal={p} onDecided={setReceipt} />
						))}
					</>
				) : (
					<p>
						No pending proposals. Open a fixed-time task and choose “Propose new time” to review a
						change.
					</p>
				)}
				<RecentDecisions onUndo={() => setReceipt("Previous time restored.")} />
			</div>
		</aside>
	);
}
