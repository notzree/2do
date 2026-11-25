import { eq } from "drizzle-orm";
import type { PlannerStore } from "../db/planner.ts";
import { days, images, taskCaptures } from "../db/schema.ts";
import type { CommitTaskWrite } from "../interfaces/database.ts";
import {
	emptyPage,
	type DayPage,
	type NotebookDoc,
	type WritePage,
} from "../interfaces/notebook.ts";
import { createTask } from "../interfaces/plan.ts";
import { Planner, PlannerError } from "./planner.ts";
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
				for (const { id, title, rawInput, typeId, captureDate, timeZone } of draft.newTasks) {
					if (!refs.has(id)) throw new PlannerError(409, "New task needs a document reference");
					this.planner.create(
						createTask.parse({ id, title, schedule: { type: "day", date: day } }),
						rawInput,
					);
					if (typeId) this.plugins.attachAtCapture(id, typeId);
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
					if (
						node.type === "image" &&
						!this.db
							.select({ id: images.id })
							.from(images)
							.where(eq(images.id, node.attrs.id))
							.get()
					)
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
