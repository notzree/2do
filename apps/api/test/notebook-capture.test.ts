import { env } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { task } from "../src/interfaces/plan.ts";
import { plannerScopeHeader } from "../src/interfaces/notebook.ts";

it("prevents an old account's draft from being replayed into another planner at the same day revision", async () => {
	const a = env.USER_PLANNER.getByName(crypto.randomUUID()), b = env.USER_PLANNER.getByName(crypto.randomUUID());
	const url = "https://test/api/days/2026-11-25";
	const scope = (await a.fetch(url)).headers.get(plannerScopeHeader);
	expect(scope).toBe(a.id.toString());
	expect((await b.fetch(url)).headers.get(plannerScopeHeader)).not.toBe(scope);
	const id = crypto.randomUUID();
	const init = {
		method: "PUT", headers: { [plannerScopeHeader]: scope!, "Content-Type": "application/json" },
		body: JSON.stringify({ version: 1, revision: 0, doc: { type: "doc", content: [{ type: "taskRef", attrs: { id } }] }, newTasks: [{ id, title: "Private note" }] }),
	};
	expect((await b.fetch(url, init)).status).toBe(412);
	expect((await b.fetch("https://test/api/tasks/" + id)).status).toBe(404);
	expect(await (await b.fetch(url)).json()).toMatchObject({ revision: 0 });
	expect((await a.fetch(url, init)).status).toBe(200);
	expect((await a.fetch(url, init)).status).toBe(200);
});

function plannerClient() {
	const planner = env.USER_PLANNER.getByName(crypto.randomUUID());
	return (path: string, method = "GET", value?: object) =>
		planner.fetch("https://planner.test/api/" + path, {
			method,
			...(value && {
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(value),
			}),
		});
}

it("captures an explicitly chosen enabled subtype in the same revision-checked page write", async () => {
	const call = plannerClient();
	const id = crypto.randomUUID();
	const typeId = "nutrition.meal";
	const body = {
		version: 1, revision: 0,
		doc: { type: "doc", content: [{ type: "taskRef", attrs: { id } }] },
		newTasks: [{ id, title: "Picnic", rawInput: "  Picnic ", typeId }],
	};
	const save = () => call("days/2026-11-24", "PUT", body);
	expect((await save()).status).toBe(404);
	expect((await call("tasks/" + id)).status).toBe(404);
	expect(await (await call("days/2026-11-24")).json()).toMatchObject({ revision: 0 });
	const enabled = await call("task-plugins/nutrition", "PUT", { enabled: true });
	expect(await enabled.json()).toMatchObject({ subtypes: [{ id: typeId, captureCommand: "meal" }] });
	expect((await save()).status).toBe(200);
	const read = async () => (await call("tasks/" + id + "/details")).json<{ subtypes: unknown[] }>();
	const first = await read();
	expect(first.subtypes).toMatchObject([{ typeId, source: "manual", data: {} }]);
	expect((await save()).status).toBe(200);
	expect((await read()).subtypes).toEqual(first.subtypes);
});

it("preserves a notebook capture through a lost save response, later edits and rescheduling", async () => {
	const call = plannerClient();
	const id = crypto.randomUUID();
	const rawInput = "  Grab dinner at nuri village on Friday!  ";
	const title = rawInput.trim();
	const notebookDate = "2026-11-27";
	const captureDate = "2026-11-24";
	const timeZone = "America/Toronto";
	const writePage = (input: string) =>
		call("days/" + notebookDate, "PUT", {
			version: 1,
			revision: 0,
			doc: { type: "doc", content: [{ type: "taskRef", attrs: { id } }] },
			newTasks: [{ id, title, rawInput: input, captureDate, timeZone }],
		});
	const path = "tasks/" + id;
	const capture = { rawInput, notebookDate, captureDate, timeZone };
	expect((await writePage(rawInput)).status).toBe(200);
	expect((await writePage(rawInput)).status).toBe(200);
	expect((await writePage(rawInput.trim())).status).toBe(409);
	expect(await (await call(path + "/capture")).json()).toEqual(capture);
	const before = task.parse(await (await call(path)).json());
	expect(
		(
			await call(path, "PATCH", {
				revision: before.revision,
				title: "Dinner at Nuri Village",
				schedule: null,
			})
		).status,
	).toBe(200);
	expect(await (await call(path + "/capture")).json()).toEqual(capture);
	expect((await plannerClient()(path + "/capture")).status).toBe(404);
	expect((await call(path, "DELETE")).status).toBe(204);
	expect((await call(path + "/capture")).status).toBe(404);
	// A new task may reuse a deleted ID. Its predecessor's capture must not reappear.
	expect((await call("tasks", "POST", { id, title: "New task" })).status).toBe(201);
	expect(await (await call(path + "/capture")).json()).toBeNull();
});

it("accepts legacy notebook saves and rolls back capture with an invalid reference", async () => {
	const call = plannerClient();
	const id = crypto.randomUUID();
	const date = "2026-11-24";
	const save = (refs: string[], item: object) =>
		call("days/" + date, "PUT", {
			version: 1,
			revision: 0,
			doc: { type: "doc", content: refs.map((id) => ({ type: "taskRef", attrs: { id } })) },
			newTasks: [item],
		});
	const legacy = { id, title: "Original unavailable" };
	expect(
		(await save([id, crypto.randomUUID()], { ...legacy, rawInput: legacy.title })).status,
	).toBe(404);
	expect((await call("tasks/" + id + "/capture")).status).toBe(404);
	expect((await save([id], legacy)).status).toBe(200);
	expect((await save([id], legacy)).status).toBe(200);
	expect(await (await call("tasks/" + id + "/capture")).json()).toBeNull();
});
