import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import {
	dayPage,
	emptyPage,
	withoutTaskReferences,
	type NotebookDoc,
} from "../src/interfaces/notebook.ts";

function owner() {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	const call = (path: string, method = "GET", body?: object) =>
		stub.fetch("https://planner.test/api/" + path, {
			method,
			...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		});
	const save = (date: string, revision: number, doc: NotebookDoc) =>
		call("days/" + date, "PUT", { version: 1, revision, doc, newTasks: [] });
	const read = async (date: string) => dayPage.parse(await (await call("days/" + date)).json());
	return { stub, call, save, read };
}
const ref = (id: string, type: "graphRef" | "taskRef" = "taskRef") => ({ type, attrs: { id } });

it("preserves a concurrently edited or recreated task when an old tab requests deletion", async () => {
	const client = owner();
	const id = crypto.randomUUID(), path = "tasks/" + id;
	const created = await (await client.call("tasks", "POST", { id, title: "Draft" })).json<{revision: number}>();
	await client.save("2026-11-25", 0, { type: "doc", content: [ref(id)] });
	const changed = await (await client.call(path, "PATCH", { title: "Revised", revision: created.revision })).json<{revision: number}>();
	const stale = path + "?expectedRevision=" + created.revision;
	expect((await client.call(stale, "DELETE")).status).toBe(409);
	expect((await client.read("2026-11-25")).revision).toBe(1);
	expect((await client.call(path + "?expectedRevision=" + changed.revision, "DELETE")).status).toBe(204);
	await client.call("tasks", "POST", { id, title: "Another task" });
	expect((await client.call(stale, "DELETE")).status).toBe(409);
	expect(await (await client.call(path)).json()).toMatchObject({ title: "Another task" });
});

it("cleans legacy orphan references on explicit deletion and reports a subsequent retry as missing", async () => {
	const client = owner(),
		date = "2026-11-25",
		id = crypto.randomUUID();
	const preserved: NotebookDoc = {
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "Keep this note about " + id }] },
		],
	};
	const saved: NotebookDoc = {
		type: "doc",
		content: [ref(id), ...preserved.content, ref(id, "graphRef")],
	};
	expect((await client.call("tasks", "POST", { id, title: "Previously deleted" })).status).toBe(
		201,
	);
	expect((await client.save(date, 0, saved)).status).toBe(200);
	await runInDurableObject(client.stub, (_, ctx) => {
		// Older versions removed the task without updating the stored notebook.
		ctx.storage.sql.exec("DELETE FROM task WHERE id = ?", id);
	});
	const path = "tasks/" + id;
	expect((await client.call(path)).status).toBe(404);
	const foreign = owner();
	expect((await foreign.call(path + "?withPages=true", "DELETE")).status).toBe(404);
	expect((await client.read(date)).doc).toEqual(saved);
	const response = await client.call(path + "?withPages=true", "DELETE");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ pages: [{ date, previousRevision: 1, revision: 2 }] });
	expect(await client.read(date)).toEqual({ version: 1, revision: 2, doc: preserved });
	expect((await client.call(path + "?withPages=true", "DELETE")).status).toBe(404);
	expect((await client.read(date)).revision).toBe(2);
});

it("deletes every matching task or graph reference, preserving other content, planners and revisions", async () => {
	const alice = owner(),
		bob = owner();
	const id = crypto.randomUUID(),
		sibling = crypto.randomUUID();
	const title = "Follow up";
	for (const [client, taskId] of [
		[alice, id],
		[alice, sibling],
		[bob, id],
	] as const) {
		expect((await client.call("tasks", "POST", { id: taskId, title })).status).toBe(201);
	}
	const uploaded = await alice.stub.fetch("https://planner.test/api/images", {
		method: "POST",
		headers: { "Content-Type": "image/png" },
		body: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
	});
	expect(uploaded.status).toBe(201);
	const { id: imageId } = await uploaded.json<{ id: string }>();
	const preserved: NotebookDoc = {
		type: "doc",
		content: [
			{ type: "heading", content: [{ type: "text", text: "Keep this" }] },
			{ type: "image", attrs: { id: imageId, alt: id } },
			ref(sibling),
			{ type: "paragraph", content: [{ type: "text", text: id, marks: [{ type: "em" }] }] },
			ref(sibling, "graphRef"),
		],
	};
	const mixed: NotebookDoc = {
		type: "doc",
		content: [
			ref(id),
			...preserved.content.slice(0, 2),
			ref(id, "graphRef"),
			...preserved.content.slice(2),
			ref(id),
		],
	};
	const onlyRefs: NotebookDoc = { type: "doc", content: [ref(id, "graphRef"), ref(id)] };
	const first = "2026-11-23",
		second = "2026-11-24",
		unaffected = "2026-11-25";
	expect(withoutTaskReferences(preserved, id)).toBe(preserved);
	expect((await alice.save(first, 0, mixed)).status).toBe(200);
	expect((await alice.save(first, 1, mixed)).status).toBe(200);
	expect((await alice.save(second, 0, onlyRefs)).status).toBe(200);
	expect((await alice.save(unaffected, 0, preserved)).status).toBe(200);
	expect((await bob.save(second, 0, onlyRefs)).status).toBe(200);

	const result = await alice.call("tasks/" + id + "?withPages=true", "DELETE");
	expect(result.status).toBe(200);
	expect(await result.json()).toEqual({
		pages: [
			{ date: first, previousRevision: 2, revision: 3 },
			{ date: second, previousRevision: 1, revision: 2 },
		],
	});
	expect(await alice.read(first)).toEqual({ version: 1, revision: 3, doc: preserved });
	expect(await alice.read(second)).toEqual({ version: 1, revision: 2, doc: emptyPage().doc });
	expect(await alice.read(unaffected)).toEqual({ version: 1, revision: 1, doc: preserved });
	expect(await bob.read(second)).toEqual({ version: 1, revision: 1, doc: onlyRefs });
	expect((await bob.call("tasks/" + id)).status).toBe(200);
	expect((await alice.call("tasks/" + sibling)).status).toBe(200);
	expect((await alice.call("tasks/" + id)).status).toBe(404);
	expect((await alice.call("tasks/" + id + "?withPages=true", "DELETE")).status).toBe(404);
	expect((await alice.save(unaffected, 0, preserved)).status).toBe(200);
	expect((await alice.save(first, 1, mixed)).status).toBe(409);
	expect((await alice.save(first, 2, mixed)).status).toBe(409);
	expect((await alice.save(first, 3, mixed)).status).toBe(404);
	expect((await alice.read(first)).revision).toBe(3);
	await runInDurableObject(alice.stub, (_, ctx) => {
		const hashes = ctx.storage.sql
			.exec<{ day: string; commandHash: string }>(
				"SELECT day, commandHash FROM day_page ORDER BY day",
			)
			.toArray();
		expect(hashes.map((x) => x.commandHash.length)).toEqual([0, 0, 64]);
	});
});

it("keeps the 204 deletion contract and returns an empty receipt for an unreferenced task", async () => {
	const client = owner();
	for (const query of ["", "?withPages=false", "?withPages=true"]) {
		const id = crypto.randomUUID();
		expect((await client.call("tasks", "POST", { id, title: "Task" })).status).toBe(201);
		const date = "2026-11-27";
		const previous = await client.read(date);
		if (query !== "?withPages=true")
			await client.save(date, previous.revision, { type: "doc", content: [ref(id)] });
		const result = await client.call("tasks/" + id + query, "DELETE");
		if (query === "?withPages=true") {
			expect(result.status).toBe(200);
			expect(await result.json()).toEqual({ pages: [] });
		} else {
			expect(result.status).toBe(204);
			expect(await result.text()).toBe("");
			expect((await client.read(date)).doc).toEqual(emptyPage().doc);
		}
	}
});

it("rolls back page edits when task deletion fails inside the transaction", async () => {
	const client = owner();
	const id = crypto.randomUUID(),
		date = "2026-11-24";
	expect((await client.call("tasks", "POST", { id, title: "Protected fixture" })).status).toBe(201);
	const doc: NotebookDoc = { type: "doc", content: [ref(id)] };
	await client.save(date, 0, doc);
	await runInDurableObject(client.stub, (_, ctx) => {
		ctx.storage.sql.exec(
			"CREATE TABLE delete_test_guard (taskId TEXT PRIMARY KEY REFERENCES task(id) ON DELETE RESTRICT)",
		);
		ctx.storage.sql.exec("INSERT INTO delete_test_guard (taskId) VALUES (?)", id);
	});
	expect((await client.call("tasks/" + id + "?withPages=true", "DELETE")).status).toBe(500);
	expect((await client.call("tasks/" + id)).status).toBe(200);
	expect(await client.read(date)).toEqual({ version: 1, revision: 1, doc });
	expect((await client.save(date, 0, doc)).status).toBe(200);
});
