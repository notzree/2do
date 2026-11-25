import { createStore } from "zustand/vanilla";
import { api, isSwitchingPlanner, pageQuery, PlannerRequestError, planKey, queryClient } from "./query.ts";
import { openNotebookDraft, type NotebookDraft } from "./notebook-drafts.ts";
import {
	dayPage,
	deleteTaskReceipt,
	withoutTaskReferences,
	plannerScopeHeader,
	type DeleteTaskReceipt,
	type DayPage,
	type NewTask,
	type NotebookDoc,
	type WritePage,
} from "@2do/api/notebook";

type Snapshot = {
	page?: DayPage;
	status: "Loading" | "Saved" | "Saving" | "Unsaved" | "Conflict";
	error?: string;
	backupWarning?: string;
};
type DeletedPage = DeleteTaskReceipt["pages"][number];
const deletions = new Map<string, { expectedRevision?: number; result: Promise<void> }>();

export class DayBuffer {
	private readonly store = createStore<Snapshot>(() => ({ status: "Loading" }));
	get = this.store.getState;
	getState = this.store.getState;
	getInitialState = this.store.getInitialState;
	subscribe = this.store.subscribe;
	private get state() {
		return this.store.getState();
	}
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pending = new Map<string, NewTask>();
	private optimisticTitles = new Map<string, string>();
	private revision = 0;
	private dirty = false;
	private running?: Promise<void>;
	private savedDoc?: NotebookDoc;
	private deferredFlush = false;
	private readonly deletionListeners = new Set<(id: string) => void>();
	generation = 0;
	private retryBody?: WritePage;
	private scope?: string;
	private opening?: Promise<void>;
	private journal?: NotebookDraft;
	constructor(readonly date: string, private readonly openDraft = openNotebookDraft) {}
	private publish(next: Snapshot) {
		this.store.setState({ ...next, backupWarning: this.checkpoint(next) }, true);
	}
	private checkpoint(next: Snapshot) {
		if (!next.page) return;
		if (!this.scope) return this.dirty ? "Account not verified for browser backup. Keep this tab open until saved." : undefined;
		try {
			if (!this.dirty) { this.journal?.clear(); return; }
			if (!this.journal) throw new Error();
			this.journal.save(this.writeBody(next.page.doc), this.retryBody, next.status === "Conflict");
		} catch {
			return this.dirty ? "Browser backup unavailable. Keep this tab open until the page is saved."
				: "Saved online. This browser could not clear its draft backup.";
		}
	}
	private writeBody(doc: NotebookDoc): WritePage {
		const ids = referenceIds(doc);
		return { version: 1, revision: this.revision, doc,
			newTasks: [...this.pending.values()].filter((task) => ids.has(task.id)) };
	}
	get hasChanges() {
		return this.dirty || !!this.running;
	}
	onTaskDeleted(listener: (id: string) => void) {
		this.deletionListeners.add(listener);
		return () => { this.deletionListeners.delete(listener); };
	}
	private concerns(id: string) {
		return this.pending.has(id) || hasReference(this.savedDoc, id) ||
			hasReference(this.state.page?.doc, id) || hasReference(this.retryBody?.doc, id);
	}
	private heldByDeletion(except?: string) {
		for (const id of deletions.keys()) if (id !== except && this.concerns(id)) return true;
		return false;
	}
	taskTitle(id: string) {
		return this.optimisticTitles.get(id);
	}
	acknowledgeTasks(tasks: readonly { id: string }[]) {
		if (!this.optimisticTitles.size) return;
		for (const task of tasks) this.optimisticTitles.delete(task.id);
	}
	receive(page: DayPage & { plannerScope?: string }, discard = false): void | Promise<void> {
		if (page.plannerScope && !this.scope && !this.dirty && !this.running) {
			this.scope = page.plannerScope;
			this.opening = this.restoreDraft(page, page.plannerScope).finally(() => { this.opening = undefined; });
			return this.opening;
		}
		if (page.plannerScope && this.scope && this.scope !== page.plannerScope) return;
		if (this.opening) return this.opening.then(() => this.receive(page, discard));
		if (
			this.running || this.heldByDeletion() ||
			(!discard && (this.dirty || page.revision < this.revision ||
				(this.state.page && page.revision === this.revision)))
		)
			return;
		this.replacePage(page);
	}
	private async restoreDraft(page: DayPage, scope: string) {
		try { this.journal = await this.openDraft(scope, this.date); } catch { /* Editing can continue while connected. */ }
		const draft = this.journal?.recovered;
		if (!draft) { this.replacePage(page); return; }
		this.revision = draft.current.revision;
		this.savedDoc = page.revision === this.revision ? page.doc : undefined;
		this.dirty = true;
		for (const task of draft.current.newTasks) {
			this.pending.set(task.id, task);
			this.optimisticTitles.set(task.id, task.title);
		}
		this.retryBody = draft.sent === true ? draft.current : draft.sent;
		const conflict = draft.conflict || (page.revision !== this.revision &&
			(!this.retryBody || page.revision !== this.retryBody.revision + 1));
		this.generation++;
		this.publish({ page: { version: 1, revision: this.revision, doc: draft.current.doc },
			status: conflict ? "Conflict" : "Saving",
			error: conflict ? "This day changed in another editor. Your recovered draft is still open." : undefined });
		if (!conflict) void this.flush();
	}
	private replacePage(page: DayPage) {
		this.revision = page.revision;
		this.savedDoc = page.doc;
		this.dirty = false;
		this.retryBody = undefined;
		this.pending.clear();
		if (this.optimisticTitles.size) {
			const refs = referenceIds(page.doc);
			for (const id of this.optimisticTitles.keys())
				if (!refs.has(id)) this.optimisticTitles.delete(id);
		}
		this.generation++;
		this.publish({ page, status: "Saved" });
	}
	async discard() {
		try {
			const page = await queryClient.fetchQuery({ ...pageQuery(this.date), staleTime: 0 });
			await this.receive(page, true);
		} catch {
			this.publish({ ...this.state, error: "Could not load the saved page." });
		}
	}
	change(doc: NotebookDoc, task?: NewTask) {
		if (task) {
			this.pending.set(task.id, task);
			this.optimisticTitles.set(task.id, task.title);
		}
		this.dirty = true;
		const page: DayPage = { version: 1, revision: this.revision, doc };
		if (this.state.status === "Conflict") {
			this.publish({ ...this.state, page });
			return;
		}
		this.publish({ page, status: "Saving" });
		clearTimeout(this.timer);
		if (task) void this.flush();
		else this.timer = setTimeout(() => void this.flush(), 350);
	}
	async flush() {
		await this.startFlush();
	}
	private startFlush(captureId?: string) {
		clearTimeout(this.timer);
		if (this.running) return this.running;
		if (!this.dirty || this.state.status === "Conflict") return;
		this.running = this.save(captureId).finally(() => { this.running = undefined; });
		return this.running;
	}
	private async save(captureId?: string) {
		try {
			while (this.dirty && this.state.page) {
				if (this.heldByDeletion(captureId)) {
					this.deferredFlush = true;
					break;
				}
				const doc = this.state.page.doc;
				const body = this.retryBody ?? this.writeBody(doc);
				this.retryBody = body;
				const backupWarning = this.checkpoint(this.state);
				if (backupWarning !== this.state.backupWarning) this.store.setState({ backupWarning });
				const { data } = await api.PUT("/api/days/{date}", {
					params: { path: { date: this.date } },
					...(this.scope && { headers: { [plannerScopeHeader]: this.scope } }),
					body,
				});
				const saved = dayPage.parse(data);
				this.savedDoc = saved.doc;
				this.revision = saved.revision;
				this.retryBody = undefined;
				this.dirty = this.state.page.doc !== body.doc;
				for (const t of body.newTasks) this.pending.delete(t.id);
				this.publish({
					page: { ...this.state.page, revision: this.revision },
					status: this.dirty ? "Saving" : "Saved",
				});
				queryClient.setQueryData(pageQuery(this.date).queryKey, { ...saved, plannerScope: this.scope });
				if (body.newTasks.length) void queryClient.invalidateQueries({ queryKey: planKey });
				if (captureId && !this.pending.has(captureId)) {
					this.deferredFlush = this.dirty;
					break;
				}
			}
		} catch (cause) {
			const failure = cause instanceof PlannerRequestError ? cause : undefined;
			if (failure && failure.status < 500 && failure.status !== 412) this.retryBody = undefined;
			this.publish({
				...this.state,
				status: failure?.status === 409 ? "Conflict" : "Unsaved",
				error: failure?.message ?? "Connection lost. Your changes are still open.",
			});
		}
	}
	async prepareTaskDeletion(id: string) {
		if (!this.concerns(id)) return;
		await this.running;
		if (!this.pending.has(id) && !this.retryBody) return;
		// Replay an ambiguous PUT verbatim, or finish creating the captured task before DELETE.
		await this.startFlush(id);
		if (this.pending.has(id) || this.retryBody || this.state.status === "Unsaved")
			throw new Error(this.state.error ?? "Save this notebook page before deleting its task.");
	}
	async confirmTaskDeletion(id: string, receipt: DeletedPage | undefined, lostReceipt: boolean) {
		if (!receipt && !this.concerns(id)) return;
		const staleBase = lostReceipt || !!(receipt && this.revision < receipt.previousRevision);
		let authoritative: DayPage | undefined;
		if (this.state.page && staleBase && (lostReceipt || !this.dirty)) {
			try {
				const result = await api.GET("/api/days/{date}", { params: { path: { date: this.date } } });
				authoritative = dayPage.parse(result.data);
				queryClient.setQueryData(pageQuery(this.date).queryKey, {
					...authoritative, plannerScope: result.response.headers.get(plannerScopeHeader) ?? this.scope,
				});
			} catch {
				// The planner invalidates its queries after this mutation, including failed reads.
			}
		}
		const page = this.state.page;
		const doc = page && withoutTaskReferences(page.doc, id);
		this.optimisticTitles.delete(id);
		this.pending.delete(id);
		if (!page || !doc) {
			if (receipt) this.revision = Math.max(this.revision, receipt.revision);
			return;
		}
		if (this.savedDoc) this.savedDoc = withoutTaskReferences(this.savedDoc, id);
		const verifiedBase = authoritative && JSON.stringify(authoritative.doc) === JSON.stringify(this.savedDoc);
		if (authoritative && !verifiedBase && !this.dirty) {
			this.replacePage(authoritative);
			return;
		}
		if (staleBase && !verifiedBase && this.dirty) {
			this.publish({ page: { ...page, doc }, status: "Conflict",
				error: "This day changed in another editor. Your draft is still open." });
		} else {
			if (verifiedBase && authoritative) this.revision = authoritative.revision;
			else if (receipt && !staleBase) this.revision = Math.max(this.revision, receipt.revision);
			this.publish({ ...this.state, page: { ...page, doc, revision: this.revision } });
		}
		if (doc !== page.doc) for (const listener of this.deletionListeners) listener(id);
	}
	resumeAfterDeletion() {
		if (!this.deferredFlush) return;
		this.deferredFlush = false;
		void this.flush();
	}
}
function hasReference(doc: NotebookDoc | undefined, id: string) {
	return doc?.content.some((node) => (node.type === "taskRef" || node.type === "graphRef") && node.attrs.id === id);
}
function referenceIds(doc: NotebookDoc) {
	return new Set(
		doc.content.flatMap((node) =>
			node.type === "taskRef" || node.type === "graphRef" ? [node.attrs.id] : [],
		),
	);
}
const days = new Map<string, DayBuffer>();
export function dayBuffer(date: string) {
	let buffer = days.get(date);
	if (!buffer) {
		buffer = new DayBuffer(date);
		days.set(date, buffer);
	}
	return buffer;
}
async function requestDeletion(id: string, expectedRevision?: number) {
	try {
		const result = await api.DELETE("/api/tasks/{id}", { params: { path: { id }, query: {
			withPages: "true", ...(expectedRevision !== undefined && { expectedRevision: String(expectedRevision) }),
		} } });
		return deleteTaskReceipt.parse(result.data).pages;
	} catch (error) {
		if (error instanceof PlannerRequestError && error.status === 404) return;
		if (error instanceof PlannerRequestError && error.status < 500) throw error;
		// A dropped response may follow a committed deletion. Only an authoritative 404 confirms it.
		try {
			await api.GET("/api/tasks/{id}", { params: { path: { id } } });
		} catch (probe) {
			if (probe instanceof PlannerRequestError && probe.status === 404) return;
		}
		throw error;
	}
}
export function deleteNotebookTask(id: string, expectedRevision?: number) {
	const active = deletions.get(id);
	if (active) {
		if (active.expectedRevision === expectedRevision) return active.result;
		return Promise.reject(new PlannerRequestError(409, "A different revision of this task is being deleted."));
	}
	const result = Promise.resolve().then(async () => {
		await Promise.all([...days.values()].map((buffer) => buffer.prepareTaskDeletion(id)));
		const pages = await requestDeletion(id, expectedRevision);
		const changes = new Map(pages?.map((page) => [page.date, page]));
		await Promise.all([...days.values()].map((buffer) =>
			buffer.confirmTaskDeletion(id, changes.get(buffer.date), !pages)));
		for (const change of pages ?? []) {
			queryClient.setQueryData<DayPage>(pageQuery(change.date).queryKey, (cached) =>
				cached?.revision === change.previousRevision
					? { ...cached, revision: change.revision, doc: withoutTaskReferences(cached.doc, id) }
					: cached,
			);
		}
		return pages && changes;
	}).finally(() => {
		deletions.delete(id);
		for (const buffer of days.values()) buffer.resumeAfterDeletion();
	}).then((changed) => queryClient.invalidateQueries({
		// Revalidate after releasing the deletion guard so buffers can receive the reply.
		// A lost receipt cannot identify the affected dates.
		queryKey: ["planner", "day"],
		predicate: ({ queryKey }) => !changed || changed.has(String(queryKey[2])),
	}));
	deletions.set(id, { expectedRevision, result });
	return result;
}
if (typeof window !== "undefined") {
	window.addEventListener("beforeunload", (event) => {
		if (!isSwitchingPlanner() && [...days.values()].some((d) => d.hasChanges)) event.preventDefault();
	});
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) for (const day of days.values()) void day.flush();
	});
}
