import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { PlannerStore } from "../db/planner.ts";
import { tasks, timeProposals } from "../db/schema.ts";
import { sameTime, type TimeProposal } from "../interfaces/review.ts";
import { Planner, PlannerError } from "./planner.ts";

type ProposalRow = typeof timeProposals.$inferSelect;
type ProposalInput = Pick<TimeProposal, "id" | "taskId" | "revision" | "after" | "reason">;

function unpack({ id, taskId, status, document }: ProposalRow): TimeProposal {
	if (status === "duplicate") throw new Error("Expected a canonical proposal.");
	const { canonicalId: _, ...data } = document;
	return { id, taskId, status, ...data };
}

export class Review {
	constructor(
		private readonly store: PlannerStore,
		private readonly planner: Planner,
	) {}

	pending() {
		return this.store
			.select({
				proposal: timeProposals,
				title: sql<string>`json_extract(${tasks.document}, '$.title')`,
			})
			.from(timeProposals)
			.innerJoin(tasks, eq(tasks.id, timeProposals.taskId))
			.where(eq(timeProposals.status, "pending"))
			.orderBy(
				asc(sql`json_extract(${timeProposals.document}, '$.createdAt')`),
				asc(timeProposals.id),
			)
			.all()
			.map(({ proposal, title }) => ({ ...unpack(proposal), title }));
	}

	recent() {
		const latest = sql`coalesce(json_extract(${timeProposals.document}, '$.undoneAt'),
			json_extract(${timeProposals.document}, '$.decidedAt'), json_extract(${timeProposals.document}, '$.createdAt'))`;
		return this.store
			.select({ proposal: timeProposals, task: tasks.document })
			.from(timeProposals)
			.innerJoin(tasks, eq(tasks.id, timeProposals.taskId))
			.where(inArray(timeProposals.status, ["accepted", "rejected", "undone"]))
			.orderBy(desc(latest), desc(timeProposals.id))
			.limit(10)
			.all()
			.map(({ proposal, task }) => ({
				...unpack(proposal),
				title: task.title,
				canUndo:
					proposal.status === "accepted" && proposal.document.acceptedRevision === task.revision,
			}));
	}

	private row(id: string) {
		return this.store.select().from(timeProposals).where(eq(timeProposals.id, id)).get();
	}

	private canonical(id: string): ProposalRow {
		const row = this.row(id);
		if (!row) throw new PlannerError(404, "Proposal not found.");
		if (row.status !== "duplicate") return row;
		const original = row.document.canonicalId && this.row(row.document.canonicalId);
		if (!original || original.status === "duplicate") throw new Error("Missing original proposal.");
		return original;
	}

	propose(input: ProposalInput, source: TimeProposal["source"]): TimeProposal {
		return this.store.transaction(() => {
			const { id, taskId, revision, after, reason } = input;
			const existing = this.row(id);
			if (existing) {
				const saved = existing.document;
				if (
					existing.taskId !== taskId ||
					saved.revision !== revision ||
					!sameTime(after, saved.after) ||
					saved.reason !== reason ||
					saved.source !== source
				)
					throw new PlannerError(409, "This proposal ID already belongs to a different request.");
				return unpack(existing.status === "duplicate" ? this.canonical(id) : existing);
			}
			const task = this.planner.get(taskId);
			if (task.revision !== revision || task.completed || task.schedule?.type !== "fixed")
				throw new PlannerError(409, "Open the latest scheduled task to propose a time.");
			if (sameTime(task.schedule, after)) throw new PlannerError(409, "Choose a different time.");
			const duplicate = this.store
				.select()
				.from(timeProposals)
				.where(and(eq(timeProposals.taskId, taskId), eq(timeProposals.status, "pending")))
				.all()
				.find(
					(p) => sameTime(task.schedule, p.document.before) && sameTime(after, p.document.after),
				);
			const document = {
				revision,
				after,
				reason,
				before: task.schedule,
				source,
				createdAt: new Date().toISOString(),
			};
			if (duplicate) {
				// Remember this request ID even after the canonical proposal leaves the inbox.
				this.store
					.insert(timeProposals)
					.values({
						id,
						taskId,
						status: "duplicate",
						document: { ...document, canonicalId: duplicate.id },
					})
					.run();
				return unpack(duplicate);
			}
			return unpack(
				this.store
					.insert(timeProposals)
					.values({
						id,
						taskId,
						status: "pending",
						document,
					})
					.returning()
					.get(),
			);
		});
	}

	decide(id: string, decision: "accept" | "reject"): TimeProposal {
		return this.store.transaction(() => {
			const row = this.canonical(id);
			const status = decision === "accept" ? "accepted" : "rejected";
			if (row.status === status) return unpack(row);
			if (row.status !== "pending")
				throw new PlannerError(409, "This proposal was already decided.");
			const document = { ...row.document, decidedAt: new Date().toISOString() };
			if (decision === "accept") {
				const task = this.planner.get(row.taskId);
				if (task.completed || !sameTime(task.schedule, document.before))
					throw new PlannerError(
						409,
						"The task changed. Reject this proposal and review its current time.",
					);
				const applied = this.planner.update(task.id, {
					revision: task.revision,
					schedule: document.after,
				});
				document.acceptedRevision = applied.revision;
			}
			return unpack(
				this.store
					.update(timeProposals)
					.set({ status, document })
					.where(eq(timeProposals.id, row.id))
					.returning()
					.get(),
			);
		});
	}

	undo(id: string): TimeProposal {
		return this.store.transaction(() => {
			const row = this.canonical(id);
			if (row.status === "undone") return unpack(row);
			if (row.status !== "accepted")
				throw new PlannerError(409, "Only an accepted time change can be undone.");
			const revision = row.document.acceptedRevision;
			if (revision === undefined)
				throw new PlannerError(409, "The applied revision was not recorded for this change.");
			const task = this.planner.get(row.taskId);
			if (task.revision !== revision || !sameTime(task.schedule, row.document.after))
				throw new PlannerError(
					409,
					"The task changed after acceptance. Review its current time before editing.",
				);
			this.planner.update(task.id, { revision, schedule: row.document.before });
			return unpack(
				this.store
					.update(timeProposals)
					.set({
						status: "undone",
						document: { ...row.document, undoneAt: new Date().toISOString() },
					})
					.where(eq(timeProposals.id, row.id))
					.returning()
					.get(),
			);
		});
	}
}
