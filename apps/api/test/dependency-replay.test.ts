import { env } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { plan, task } from "../src/interfaces/plan.ts";

it("allows dependency retries in the requested state and rejects stale edits that would reverse a later decision", async () => {
	const owner = env.USER_PLANNER.getByName(crypto.randomUUID());
	const base = "https://planner.test/api/";
	const read = async () => plan.parse(await (await owner.fetch(base + "tasks")).json());
	const create = async (title: string) =>
		task.parse(await (await owner.fetch(base + "tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title }),
		})).json());
	const a = await create("Draft");
	const b = await create("Review");
	const path = base + "dependencies/" + a.id + "/" + b.id;
	const change = (method: "PUT" | "DELETE", revision?: number) =>
		owner.fetch(path + (revision === undefined ? "" : "?expectedRevision=" + revision), { method });

	const empty = await read();
	expect((await change("PUT", empty.revision)).status).toBe(204);
	const linked = await read();
	expect(linked.edges).toEqual([{ from: a.id, to: b.id }]);
	expect((await change("PUT", empty.revision)).status).toBe(204);
	expect(await read()).toEqual(linked);

	expect((await change("DELETE", linked.revision)).status).toBe(204);
	const unlinked = await read();
	expect(unlinked.edges).toEqual([]);
	expect((await change("DELETE", linked.revision)).status).toBe(204);
	expect((await change("PUT", empty.revision)).status).toBe(409);
	expect(await read()).toEqual(unlinked);

	expect((await change("PUT", unlinked.revision)).status).toBe(204);
	const restored = await read();
	expect((await change("DELETE", linked.revision)).status).toBe(409);
	expect(await read()).toEqual(restored);
	expect((await change("DELETE", -1)).status).toBe(400);
	expect((await change("DELETE")).status).toBe(204);
	expect((await read()).edges).toEqual([]);
});
