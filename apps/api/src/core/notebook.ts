import { extractTaskTime, type TaskTiming } from "../extractors/task-time.ts";
import { extractSubtasks, type TaskOutline } from "../extractors/subtasks.ts";
import type { TitleExtractor } from "../extractors/clairic.ts";
import { eq } from "drizzle-orm";
import type { PlannerStore } from "../db/planner.ts";
import { days, taskCaptures } from "../db/schema.ts";
import { ownsImage } from "../db/planner-images.ts";
import type { CommitTaskWrite } from "../interfaces/database.ts";
import {
	emptyPage,
	type DayPage,
	type NotebookDoc,
	type WritePage,
} from "../interfaces/notebook.ts";
import { createTask } from "../interfaces/plan.ts";
import { Planner, PlannerError } from "./planner.ts";
import type { PlannerGoals } from "./goals.ts";
import { plannerGoals } from "../db/schema.ts";
import type { TaskPlugins } from "./task-plugins.ts";

function references(doc: NotebookDoc) {
	return new Set(
		doc.content.flatMap((node) =>
			node.type === "taskRef" || node.type === "graphRef" ? [node.attrs.id] : [],
		),
	);
}
export class Notebook {
	constructor(
		private readonly db: PlannerStore,
		private readonly planner: Planner,
		private readonly commit: CommitTaskWrite,
		private readonly plugins: TaskPlugins,
		private readonly goals: PlannerGoals,
		private readonly extract?: TitleExtractor,
	) {}
	private row(day: string) {
		return this.db.select().from(days).where(eq(days.day, day)).get();
	}
	readDay(day: string): DayPage {
		const row = this.row(day);
		return row ? { version: 1, revision: row.revision, doc: row.document } : emptyPage();
	}
	readTaskCapture(id: string) {
		this.planner.get(id);
		return (
			this.db.select().from(taskCaptures).where(eq(taskCaptures.taskId, id)).get()?.document ?? null
		);
	}
	async saveDay(day: string, draft: WritePage): Promise<DayPage> {
		// Zod has already normalized object keys and defaults. Hash before opening storage transactions.
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify(draft)),
		);
		const commandHash = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const captures = new Map<string, { outline?: TaskOutline; timing: TaskTiming }>();
		// Replays and stale writes need no inference. Recheck the revision in the transaction after inference.
		if (this.extract && (this.row(day)?.revision ?? 0) === draft.revision) {
			for (let i = 0; i < draft.newTasks.length; i += 8) {
				await Promise.all(draft.newTasks.slice(i, i + 8).map(async (task) => {
					const text = task.rawInput ?? task.title;
					const [outline, timing] = await Promise.all([
						task.typeId ? undefined : extractSubtasks(this.extract, text),
						extractTaskTime(this.extract, text, {
							timeZone: task.timeZone ?? this.planner.titleZone(),
							defaultDate: day,
							referenceDate: task.captureDate ?? day,
							deadline: this.plugins.captureTiming(task.typeId) === "deadline",
						}),
					]);
					captures.set(task.id, { outline, timing });
				}));
			}
		}
		return this.commit(() =>
			this.db.transaction(() => {
				const current = this.row(day);
				const revision = current?.revision ?? 0;
				if (revision !== draft.revision) {
					if (current && revision === draft.revision + 1 && current.commandHash === commandHash)
						return { version: 1, revision, doc: current.document };
					throw new PlannerError(
						409,
						"This day changed in another editor. Your draft is still open.",
					);
				}
				const previousRefs = references(current?.document ?? emptyPage().doc);
				const refs = references(draft.doc);
				const goalRefs = new Set(draft.doc.content.flatMap(n=>n.type === "goalRef" ? [n.attrs.id] : []));
				for (const goal of draft.newGoals ?? []) {
					if (!goalRefs.has(goal.id)) throw new PlannerError(409,"New goal needs a document reference");
					this.goals.create(goal);
				}
				for (const id of goalRefs) if (!this.db.select({id:plannerGoals.id}).from(plannerGoals).where(eq(plannerGoals.id,id)).get())
					throw new PlannerError(404,"Goal not found");
				for (const { id, title, rawInput, typeId, alias, captureDate, timeZone } of draft.newTasks) {
					if (!refs.has(id)) throw new PlannerError(409, "New task needs a document reference");
					this.planner.createOutline(
						createTask.parse({ id, title, titleContext: { defaultDate: day, referenceDate: captureDate ?? day, timeZone } }),
						captures.get(id)?.outline,
						rawInput,
						captures.get(id)?.timing,
						captureDate,
					);
					if (typeId) this.plugins.attachAtCapture(id, typeId, rawInput, alias);
					if (rawInput !== undefined) {
						this.db
							.insert(taskCaptures)
							.values({
								taskId: id,
								currentInput: true,
								document: { rawInput, notebookDate: day, captureDate, timeZone },
							})
							.run();
					}
				}
				for (const id of refs) if (!previousRefs.has(id)) this.planner.get(id);
				for (const node of draft.doc.content) {
					if (node.type === "image" && !ownsImage(this.db, node.attrs.id))
						throw new PlannerError(404, "Image unavailable");
				}
				const next = { revision: revision + 1, document: draft.doc, commandHash };
				this.db
					.insert(days)
					.values({ day, ...next })
					.onConflictDoUpdate({ target: days.day, set: next })
					.run();
				return { version: 1, revision: next.revision, doc: next.document };
			}),
		);
	}
}
