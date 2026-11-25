import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { emptyPage, plannerScopeHeader, type NewTask, type NotebookDoc, type WritePage } from "@2do/api/notebook";
import { DayBuffer } from "./day-buffer.ts";
import { openNotebookDraft, type NotebookDraft } from "./notebook-drafts.ts";
import { api, PlannerRequestError, queryClient } from "./query.ts";

const date = "2026-12-10";
const textDoc = (text: string): NotebookDoc => ({
	type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const receipt = (doc: NotebookDoc, revision: number) => ({
	data: { version: 1 as const, revision, doc }, response: new Response(),
});
const page = (scope: string, doc = emptyPage().doc, revision = 0) => ({
	version: 1 as const, revision, doc, plannerScope: scope,
});
function browser() {
	const values = new Map<string, string>();
	const storage: Storage = {
		get length() { return values.size; },
		key: (i) => [...values.keys()][i] ?? null,
		getItem: (k) => values.get(k) ?? null,
		setItem: (k, v) => { values.set(k, v); },
		removeItem: (k) => { values.delete(k); },
		clear: () => values.clear(),
	};
	const held = new Set<string>();
	const locks = { async request(name: string, _options: unknown, work: (lock: unknown) => unknown) {
		if (held.has(name)) return work(null);
		held.add(name);
		try { return await work({ name }); } finally { held.delete(name); }
	} } as LockManager;
	return {
		values, storage,
		tab() {
			let slot: NotebookDraft;
			const buffer = new DayBuffer(date, async (scope) => {
				slot = await openNotebookDraft(scope, date, storage, locks);
				return slot;
			});
			return { buffer, close: async () => { slot.release(); await Promise.resolve(); } };
		},
	};
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { queryClient.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("recovers a pre-debounce note on a verified reopen and clears only after ACK", async () => {
	const profile = browser();
	const first = profile.tab();
	const note = textDoc("Before closing the tab");
	const ack = Promise.withResolvers<ReturnType<typeof receipt>>();
	const put = vi.spyOn(api, "PUT").mockReturnValueOnce(ack.promise);
	await first.buffer.receive(page("A"));
	first.buffer.change(note);
	expect(profile.values.size).toBe(1);
	expect(put).not.toHaveBeenCalled();
	await first.close();
	vi.clearAllTimers(); // Old document's timers disappear when its browsing context closes.
	const other = profile.tab();
	await other.buffer.receive(page("B"));
	expect(other.buffer.get().page?.doc).toEqual(emptyPage().doc);
	expect(put).not.toHaveBeenCalled();
	const reopened = profile.tab();
	await reopened.buffer.receive(page("A"));
	expect(reopened.buffer.get().page?.doc).toEqual(note);
	expect(put.mock.calls[0][1]).toMatchObject({ body: { revision: 0, doc: note }, headers: { [plannerScopeHeader]: "A" } });
	expect(profile.values.size).toBe(1);
	ack.resolve(receipt(note, 1));
	await reopened.buffer.flush();
	expect(profile.values.size).toBe(0);
	await reopened.close(); await other.close();
});

it("replays an interrupted PUT identically, then saves prose typed during that request", async () => {
	const profile = browser();
	const first = profile.tab();
	const task: NewTask = { id: crypto.randomUUID(), title: "Dinner", rawInput: "  Dinner  " };
	const doc: NotebookDoc = { type: "doc", content: [{ type: "taskRef", attrs: { id: task.id } }, { type: "paragraph" }] };
	const next: NotebookDoc = { type: "doc", content: [doc.content[0], ...textDoc("And this").content] };
	const put = vi.spyOn(api, "PUT").mockReturnValueOnce(new Promise(() => {}))
		.mockResolvedValueOnce(receipt(doc, 1)).mockResolvedValueOnce(receipt(next, 2));
	await first.buffer.receive(page("A"));
	first.buffer.change(doc, task);
	first.buffer.change(next);
	const attempt = put.mock.calls[0][1];
	await first.close(); vi.clearAllTimers();
	const reopened = profile.tab();
	await reopened.buffer.receive(page("A", doc, 1)); // Server committed, ACK never reached the tab.
	await reopened.buffer.flush();
	expect(put.mock.calls[1][1]).toEqual(attempt);
	expect(put.mock.calls[2][1]).toMatchObject({ body: { revision: 1, doc: next, newTasks: [] } });
	expect(profile.values.size).toBe(0);
	await reopened.close();
});

it("preserves both divergent tabs and restores the stale snapshot as a conflict", async () => {
	const profile = browser();
	const left = profile.tab(), right = profile.tab();
	const first = textDoc("Updated in first tab"), second = textDoc("Updated in second tab");
	await left.buffer.receive(page("A")); left.buffer.change(first);
	await right.buffer.receive(page("A"));
	expect(right.buffer.get().page?.doc).toEqual(emptyPage().doc);
	right.buffer.change(second);
	expect(profile.values.size).toBe(2);
	await left.close(); vi.clearAllTimers();
	const recoverLeft = profile.tab();
	const put = vi.spyOn(api, "PUT").mockResolvedValueOnce(receipt(first, 1));
	await recoverLeft.buffer.receive(page("A"));
	await recoverLeft.buffer.flush();
	expect(profile.values.size).toBe(1);
	await right.close();
	const recoverRight = profile.tab();
	await recoverRight.buffer.receive(page("A", first, 1));
	expect(recoverRight.buffer.get()).toMatchObject({ status: "Conflict", page: { revision: 0, doc: second } });
	await recoverRight.buffer.flush();
	expect(put).toHaveBeenCalledTimes(1);
	expect(profile.values.size).toBe(1);
	await recoverRight.close(); await recoverLeft.close();
});

it("retains the original scope and payload on authentication failure; warns if browser backup cannot grow", async () => {
	const profile = browser(), tab = profile.tab();
	await tab.buffer.receive(page("A"));
	const first = textDoc("Original draft");
	tab.buffer.change(first);
	const lastBackup = [...profile.values.values()][0];
	vi.spyOn(profile.storage, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded"); });
	const newer = textDoc("More recent unsaved edits");
	tab.buffer.change(newer);
	expect(tab.buffer.get().backupWarning).toMatch(/Keep this tab open/);
	expect([...profile.values.values()][0]).toBe(lastBackup);
	const put = vi.spyOn(api, "PUT").mockRejectedValueOnce(new PlannerRequestError(412, "The planner changed"));
	await tab.buffer.flush();
	expect(put.mock.calls[0][1]).toMatchObject({ headers: { [plannerScopeHeader]: "A" } });
	expect(tab.buffer.get()).toMatchObject({ status: "Unsaved", page: { doc: newer } });
	await tab.close();
});
