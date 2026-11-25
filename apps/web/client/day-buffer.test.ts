import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { emptyPage, type DeleteTaskReceipt, type NewTask, type NotebookDoc } from "@2do/api/notebook";
import { api, pageQuery, PlannerRequestError, queryClient } from "./query.ts";
import { DayBuffer, dayBuffer, deleteNotebookTask } from "./day-buffer.ts";

const taskApi: {
	DELETE(path: "/api/tasks/{id}", input: { params: { path: { id: string }; query: { withPages: "true" } } }):
		Promise<{ data?: DeleteTaskReceipt; response: Response }>;
} = api;

let task: NewTask;
beforeEach(() => {
	task = { id: crypto.randomUUID(), title: "Dinner", rawInput: "  Dinner " };
	vi.useFakeTimers();
});
afterEach(() => {
	queryClient.clear();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function notebook(note = ""): NotebookDoc {
	return {
		type: "doc",
		content: [
			{ type: "taskRef", attrs: { id: task.id } },
			note ? { type: "paragraph", content: [{ type: "text", text: note }] } : { type: "paragraph" },
		],
	};
}
function receipt(doc: NotebookDoc, revision: number) {
	return { data: { version: 1 as const, revision, doc }, response: new Response() };
}

it("flushes a capture immediately and keeps the optimistic title through a delayed plan read", async () => {
	const doc = notebook();
	const put = vi.spyOn(api, "PUT").mockResolvedValueOnce(receipt(doc, 1));
	const buffer = new DayBuffer("2026-11-24");
	buffer.receive(emptyPage());
	buffer.change(doc, task);
	expect(put).toHaveBeenCalledTimes(1);
	expect(put.mock.calls[0][1]).toMatchObject({ body: { doc, revision: 0, newTasks: [task] } });
	expect(buffer.taskTitle(task.id)).toBe("Dinner");
	await vi.advanceTimersByTimeAsync(0);
	expect(buffer.get().status).toBe("Saved");
	buffer.acknowledgeTasks([]);
	expect(buffer.taskTitle(task.id)).toBe("Dinner");
	buffer.acknowledgeTasks([{ id: task.id }]);
	expect(buffer.taskTitle(task.id)).toBeUndefined();
});

it("saves the next paragraph at the acknowledged revision while the capture is in flight", async () => {
	const doc = notebook();
	const next = notebook("Finish the report");
	const delayed = Promise.withResolvers<ReturnType<typeof receipt>>();
	const put = vi.spyOn(api, "PUT")
		.mockReturnValueOnce(delayed.promise)
		.mockResolvedValueOnce(receipt(next, 2));
	const buffer = new DayBuffer("2026-11-24");
	buffer.receive(emptyPage());
	const generation = buffer.generation;
	buffer.change(doc, task);
	buffer.change(next);
	void buffer.flush();
	expect(put).toHaveBeenCalledTimes(1);
	delayed.resolve(receipt(doc, 1));
	await vi.advanceTimersByTimeAsync(0);
	expect(put.mock.calls[1][1]).toMatchObject({ body: { doc: next, revision: 1, newTasks: [] } });
	expect(buffer.get().page?.doc).toEqual(next);
	expect(buffer.generation).toBe(generation);
});

it("waits for an immediate capture, then deletes its references while preserving subsequent edits", async () => {
	const date = "2026-12-01";
	const buffer = dayBuffer(date);
	const doc = notebook();
	const capture = Promise.withResolvers<ReturnType<typeof receipt>>();
	const deletion = Promise.withResolvers<{ data: DeleteTaskReceipt; response: Response }>();
	const retained: NotebookDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep my note" }] }] };
	const put = vi.spyOn(api, "PUT").mockReturnValueOnce(capture.promise).mockResolvedValueOnce(receipt(retained, 3));
	const del = vi.spyOn(taskApi, "DELETE").mockReturnValueOnce(deletion.promise);
	buffer.receive(emptyPage());
	const generation = buffer.generation;
	const changed = vi.fn();
	const unsubscribe = buffer.onTaskDeleted(changed);
	buffer.change(doc, task);
	const remove = deleteNotebookTask(task.id);
	expect(deleteNotebookTask(task.id)).toBe(remove);
	await vi.advanceTimersByTimeAsync(0);
	expect(del).not.toHaveBeenCalled();
	capture.resolve(receipt(doc, 1));
	await vi.advanceTimersByTimeAsync(0);
	expect(del).toHaveBeenCalledOnce();
	buffer.change(notebook("Keep my note"));
	await vi.advanceTimersByTimeAsync(500);
	expect(put).toHaveBeenCalledTimes(1);
	deletion.resolve({ data: { pages: [{ date, previousRevision: 1, revision: 2 }] }, response: new Response() });
	await remove;
	await buffer.flush();
	expect(put.mock.calls[1][1]).toMatchObject({ body: { revision: 2, newTasks: [], doc: retained } });
	expect(buffer.get().page).toMatchObject({ revision: 3, doc: retained });
	expect(buffer.taskTitle(task.id)).toBeUndefined();
	expect(changed).toHaveBeenCalledExactlyOnceWith(task.id);
	expect(buffer.generation).toBe(generation);
	unsubscribe();
});

it("reconciles clean and unsaved task/graph links and protects a stale page revision", async () => {
	const dates = ["2026-12-02", "2026-12-03", "2026-12-04"];
	const [clean, local, stale] = dates.map(dayBuffer);
	const linked: NotebookDoc = { type: "doc", content: [
		{ type: "graphRef", attrs: { id: task.id } }, ...notebook("Keep").content,
	] };
	const retained: NotebookDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep" }] }] };
	clean.receive({ version: 1, revision: 7, doc: linked });
	local.receive(emptyPage());
	local.change(linked);
	stale.receive({ version: 1, revision: 1, doc: notebook() });
	stale.change(linked);
	queryClient.setQueryData(pageQuery(dates[0]).queryKey, clean.get().page);
	vi.spyOn(taskApi, "DELETE").mockResolvedValue({ data: { pages: [
		{ date: dates[0], previousRevision: 7, revision: 8 },
		{ date: dates[2], previousRevision: 4, revision: 5 },
	] }, response: new Response() });
	const put = vi.spyOn(api, "PUT").mockResolvedValueOnce(receipt(retained, 1));
	await deleteNotebookTask(task.id);
	await vi.advanceTimersByTimeAsync(400);
	expect(clean.get()).toMatchObject({ status: "Saved", page: { revision: 8, doc: retained } });
	expect(queryClient.getQueryData(pageQuery(dates[0]).queryKey)).toEqual(clean.get().page);
	expect(local.get()).toMatchObject({ status: "Saved", page: { revision: 1, doc: retained } });
	expect(stale.get()).toMatchObject({ status: "Conflict", page: { revision: 1, doc: retained } });
	expect(put).toHaveBeenCalledTimes(1);
	expect(put.mock.calls[0][1]).toMatchObject({ params: { path: { date: dates[1] } }, body: { revision: 0, doc: retained } });
});

it("leaves the row and draft in place when DELETE fails and resumes pending prose saves", async () => {
	const date = "2026-12-05";
	const buffer = dayBuffer(date);
	buffer.receive({ version: 1, revision: 1, doc: notebook() });
	const deletion = Promise.withResolvers<never>();
	vi.spyOn(api, "DELETE").mockReturnValueOnce(deletion.promise);
	vi.spyOn(api, "GET").mockRejectedValueOnce(new TypeError("Disconnected"));
	const changed = vi.fn();
	const unsubscribe = buffer.onTaskDeleted(changed);
	const next = notebook("Still here");
	const put = vi.spyOn(api, "PUT").mockResolvedValueOnce(receipt(next, 2));
	const remove = deleteNotebookTask(task.id);
	const failure = expect(remove).rejects.toThrow("Delete failed");
	buffer.change(next);
	await vi.advanceTimersByTimeAsync(400);
	expect(put).not.toHaveBeenCalled();
	deletion.reject(new PlannerRequestError(500, "Delete failed"));
	await failure;
	await buffer.flush();
	expect(buffer.get().page?.doc).toEqual(next);
	expect(put.mock.calls[0][1]).toMatchObject({ body: { revision: 1, doc: next } });
	expect(changed).not.toHaveBeenCalled();
	unsubscribe();
});

it("replays the identical capture after a lost response before sending newer edits", async () => {
	const doc = notebook();
	const next = notebook("Another note");
	const put = vi.spyOn(api, "PUT")
		.mockRejectedValueOnce(new TypeError("Connection lost"))
		.mockResolvedValueOnce(receipt(doc, 1))
		.mockResolvedValueOnce(receipt(next, 2));
	const buffer = new DayBuffer("2026-11-24");
	buffer.receive(emptyPage());
	buffer.change(doc, task);
	await vi.advanceTimersByTimeAsync(0);
	expect(buffer.get().status).toBe("Unsaved");
	expect(buffer.taskTitle(task.id)).toBe(task.title);
	buffer.change(next);
	expect(put).toHaveBeenCalledTimes(1);
	await buffer.flush();
	expect(put.mock.calls[1][1]).toEqual(put.mock.calls[0][1]);
	expect(put.mock.calls[2][1]).toMatchObject({ body: { revision: 1, doc: next, newTasks: [] } });
	expect(buffer.get().status).toBe("Saved");
	expect(buffer.taskTitle(task.id)).toBe(task.title);
});

it("recovers a committed delete after its response is lost without resaving stale references", async () => {
	const date = "2026-12-06";
	const buffer = dayBuffer(date);
	const base = notebook("Earlier note");
	const saved = { type: "doc" as const, content: base.content.slice(1) };
	buffer.receive({ version: 1, revision: 1, doc: base });
	const deletion = Promise.withResolvers<never>();
	vi.spyOn(taskApi, "DELETE").mockReturnValueOnce(deletion.promise);
	const lookup = vi.spyOn(api, "GET")
		.mockRejectedValueOnce(new PlannerRequestError(404, "Task not found"))
		.mockResolvedValueOnce(receipt(saved, 2));
	const next = notebook("Typed while deleting");
	const retained = { type: "doc" as const, content: next.content.slice(1) };
	const put = vi.spyOn(api, "PUT").mockResolvedValueOnce(receipt(retained, 3));
	const remove = deleteNotebookTask(task.id);
	buffer.change(next);
	await vi.advanceTimersByTimeAsync(400);
	deletion.reject(new TypeError("Lost response"));
	await remove;
	await buffer.flush();
	expect(lookup).toHaveBeenNthCalledWith(1, "/api/tasks/{id}", { params: { path: { id: task.id } } });
	expect(lookup).toHaveBeenNthCalledWith(2, "/api/days/{date}", { params: { path: { date } } });
	expect(put).toHaveBeenCalledTimes(1);
	expect(put.mock.calls[0][1]).toMatchObject({ body: { revision: 2, doc: retained, newTasks: [] } });
	expect(buffer.get()).toMatchObject({ status: "Saved", page: { revision: 3, doc: retained } });
});

it("reloads a clean stale page with another editor's changes", async () => {
	const date = "2026-12-07";
	const buffer = dayBuffer(date);
	buffer.receive({ version: 1, revision: 1, doc: notebook("Local base") });
	const remote: NotebookDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Updated elsewhere" }] }] };
	vi.spyOn(taskApi, "DELETE").mockResolvedValueOnce({ data: { pages: [{ date, previousRevision: 3, revision: 4 }] }, response: new Response() });
	vi.spyOn(api, "GET").mockResolvedValueOnce(receipt(remote, 4));
	await deleteNotebookTask(task.id);
	expect(buffer.get()).toMatchObject({ status: "Saved", page: { revision: 4, doc: remote } });
	expect(buffer.hasChanges).toBe(false);
});

it("keeps a failed pending capture and skips DELETE when its save cannot be confirmed", async () => {
	const date = "2026-12-08";
	const buffer = dayBuffer(date);
	buffer.receive(emptyPage());
	const failed = Promise.withResolvers<never>();
	const put = vi.spyOn(api, "PUT").mockReturnValueOnce(failed.promise)
		.mockRejectedValueOnce(new TypeError("Disconnected"));
	const del = vi.spyOn(taskApi, "DELETE");
	buffer.change(notebook(), task);
	const remove = deleteNotebookTask(task.id);
	const failure = expect(remove).rejects.toThrow("Connection lost");
	await vi.advanceTimersByTimeAsync(700);
	expect(del).not.toHaveBeenCalled();
	failed.reject(new TypeError("Disconnected"));
	await failure;
	expect(put.mock.calls[0][1]).toEqual(put.mock.calls[1][1]);
	expect(del).not.toHaveBeenCalled();
	expect(buffer.get()).toMatchObject({ status: "Unsaved", page: { revision: 0, doc: notebook() } });
	expect(buffer.taskTitle(task.id)).toBe(task.title);
});
