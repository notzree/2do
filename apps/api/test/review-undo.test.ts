import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { task } from "../src/interfaces/plan.ts";
import { recentDecision, timeProposal } from "../src/interfaces/review.ts";
import tools from "../src/mcp/tools.json";

const before = {
	type: "fixed",
	start: "2026-11-27T18:00:00Z",
	end: "2026-11-27T19:00:00Z",
} as const;
const after = {
	type: "fixed",
	start: "2026-11-27T19:00:00Z",
	end: "2026-11-27T20:00:00Z",
} as const;

async function fixture() {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	const call = (path: string, method = "GET", body?: object) =>
		stub.fetch("https://planner.test/api/" + path, {
			method,
			...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		});
	const initial = task.parse(
		await (await call("tasks", "POST", { title: "Gym", schedule: before })).json(),
	);
	const request = {
		id: crypto.randomUUID(),
		taskId: initial.id,
		revision: initial.revision,
		after,
		reason: "Later class",
	};
	const propose = async (id: string) =>
		timeProposal.parse(await (await call("review", "POST", { ...request, id })).json());
	const decide = (decision: "accept" | "reject") =>
		call("review/" + request.id + "/decision", "POST", { decision });
	const undo = () => call("review/" + request.id + "/undo", "POST");
	const read = async () => task.parse(await (await call("tasks/" + initial.id)).json());
	const recent = async () =>
		recentDecision.array().parse(await (await call("review/recent")).json());
	return { stub, call, initial, request, propose, decide, undo, read, recent };
}

it("undoes the recorded acceptance once and preserves unrelated edits made before acceptance", async () => {
	expect(tools.map((tool) => tool.name)).not.toContain("undoTime");
	const f = await fixture();
	await f.propose(f.request.id);
	expect((await f.undo()).status).toBe(409);
	expect(
		(
			await f.call("tasks/" + f.initial.id, "PATCH", {
				revision: f.initial.revision,
				title: "Climbing",
			})
		).status,
	).toBe(200);
	const accepted = timeProposal.parse(await (await f.decide("accept")).json());
	expect(accepted.acceptedRevision).toBe((await f.read()).revision);
	expect(await f.recent()).toMatchObject([
		{ id: f.request.id, title: "Climbing", status: "accepted", canUndo: true },
	]);
	const other = await fixture();
	expect((await other.call("review/" + f.request.id + "/undo", "POST")).status).toBe(404);
	const replies = await Promise.all([f.undo(), f.undo()]);
	expect(replies.map((r) => r.status)).toEqual([200, 200]);
	const [one, two] = await Promise.all(replies.map((r) => r.json()));
	expect(one).toEqual(two);
	expect(await f.read()).toMatchObject({
		schedule: before,
		title: "Climbing",
		revision: accepted.acceptedRevision! + 1,
	});
	expect(await f.recent()).toMatchObject([{ status: "undone", canUndo: false }]);
	expect((await f.decide("accept")).status).toBe(409);
	expect(await (await f.call("review")).json()).toEqual([]);
});

it("refuses undo after a later edit and for older acceptance records without a revision receipt", async () => {
	const f = await fixture();
	await f.propose(f.request.id);
	await f.decide("accept");
	const applied = await f.read();
	await f.call("tasks/" + f.initial.id, "PATCH", {
		revision: applied.revision,
		title: "Renamed after acceptance",
	});
	expect((await f.undo()).status).toBe(409);
	expect(await f.read()).toMatchObject({
		title: "Renamed after acceptance",
		schedule: after,
		revision: applied.revision + 1,
	});
	expect(await f.recent()).toMatchObject([{ status: "accepted", canUndo: false }]);

	const legacy = await fixture();
	await legacy.propose(legacy.request.id);
	await legacy.decide("accept");
	await runInDurableObject(legacy.stub, (_, ctx) => {
		ctx.storage.sql.exec(
			"UPDATE time_proposal SET document = json_remove(document, '$.acceptedRevision', '$.decidedAt') WHERE id = ?",
			legacy.request.id,
		);
	});
	expect((await legacy.undo()).status).toBe(409);
	expect(await legacy.recent()).toMatchObject([{ status: "accepted", canUndo: false }]);
});

it("replays a coalesced request after rejection without reopening it and bounds recent decisions", async () => {
	const f = await fixture();
	const alias = crypto.randomUUID();
	await f.propose(f.request.id);
	expect((await f.propose(alias)).id).toBe(f.request.id);
	await f.decide("reject");
	expect(await f.propose(alias)).toMatchObject({ id: f.request.id, status: "rejected" });
	expect(await (await f.call("review")).json()).toEqual([]);
	expect(await f.recent()).toHaveLength(1);
	expect(
		(await f.call("review", "POST", { ...f.request, id: alias, reason: "Different request" }))
			.status,
	).toBe(409);
	for (let i = 0; i < 10; i++) {
		const next = await f.propose(crypto.randomUUID());
		await f.call("review/" + next.id + "/decision", "POST", { decision: "reject" });
	}
	const recent = await f.recent();
	expect(recent).toHaveLength(10);
	expect(recent.some((p) => p.id === alias)).toBe(false);
	expect(recent.map((p) => p.decidedAt)).toEqual(
		recent
			.map((p) => p.decidedAt)
			.sort()
			.reverse(),
	);
});
