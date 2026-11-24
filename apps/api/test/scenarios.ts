import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { identify } from "../src/access.ts";
import { plan, task } from "../src/interfaces/plan.ts";

export async function checkPlanner(env: Env) {
	const alice = env.USER_PLANNER.getByName(crypto.randomUUID());
	const bob = env.USER_PLANNER.getByName(crypto.randomUUID());
	const base = "https://planner.test/api/";
	const call = (path: string, method = "GET", body?: unknown) =>
		alice.fetch(base + path, {
			method,
			...(body === undefined
				? {}
				: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		});
	const read = async () => plan.parse(await (await call("tasks")).json());
	const create = async (name: string, placement?: object) => {
		const response = await call("tasks", "POST", { title: name, placement });
		assert.equal(response.status, 201);
		return task.parse(await response.json()).id;
	};
	const edge = (from: string, to: string, method = "PUT") =>
		call("dependencies/" + from + "/" + to, method);
	const reach = async (id: string, direction: string) =>
		(
			await (await call("tasks/" + id + "/traverse/" + direction)).json<{ taskIds: string[] }>()
		).taskIds.sort();
	const a = await create("Prepare lunch"),
		b = await create("Eat lunch"),
		c = await create("Set the table");
	assert.equal((await edge(a, b)).status, 204);
	assert.equal((await edge(c, b)).status, 204);
	const revision = (await read()).revision;
	assert.equal((await edge(b, a)).status, 409);
	assert.equal((await edge(a, a)).status, 409);
	assert.equal((await edge(a, b)).status, 204);
	assert.equal(
		(
			await call("tasks", "POST", {
				title: "orphan",
				placement: { anchor: crypto.randomUUID(), side: "before" },
			})
		).status,
		404,
	);
	assert.equal((await read()).revision, revision);
	assert.equal((await read()).tasks.length, 3);

	const middle = await create("Serve", { anchor: b, side: "before" });
	const first = await create("Wash hands", { anchor: a, side: "after" });
	const snapshot = await read();
	assert.deepEqual(
		snapshot.edges.map((e) => e.from + "/" + e.to).sort(),
		[a + "/" + first, first + "/" + middle, c + "/" + middle, middle + "/" + b].sort(),
	);
	assert.deepEqual(await reach(b, "ancestors"), [a, first, c, middle].sort());
	assert.deepEqual(await reach(first, "descendants"), [middle, b].sort());
	const order = snapshot.tasks.map((t) => t.id);
	for (const e of snapshot.edges) assert.ok(order.indexOf(e.from) < order.indexOf(e.to));
	assert.equal((await edge(b, c)).status, 409);
	assert.equal((await bob.fetch(base + "tasks/" + a)).status, 404);
	assert.equal((await call("tasks/" + b, "PATCH", { completed: true, kind: "meal" })).status, 200);
	assert.equal(task.parse(await (await call("tasks/" + b)).json()).completed, true);
	assert.equal(
		(
			await call("tasks/" + b, "PATCH", {
				schedule: { type: "fixed", start: "2026-03-01T23:00:00Z", end: "2026-03-01T18:00:00Z" },
			})
		).status,
		400,
	);
	assert.equal((await call("tasks/" + b, "PATCH", { bogus: true })).status, 400);
	assert.equal((await call("tasks/" + b, "PATCH", {})).status, 400);
	assert.equal((await call("tasks", "POST", { title: "   " })).status, 400);
	assert.equal((await call("tasks", "POST", { title: "duplicate", id: b })).status, 409);
	assert.equal((await edge(c, middle, "DELETE")).status, 204);
	assert.equal((await call("tasks/" + middle, "DELETE")).status, 204);
	assert.deepEqual((await read()).edges, [{ from: a, to: first }]);
	assert.equal((await call("tasks/" + middle)).status, 404);

	const child = await create("Pack lunch");
	assert.equal((await call("tasks/" + child, "PATCH", { parentId: a })).status, 200);
	assert.equal((await call("tasks/" + a, "PATCH", { parentId: child })).status, 409);
	assert.equal(
		(await call("tasks/" + child, "PATCH", { parentId: crypto.randomUUID() })).status,
		404,
	);
	assert.equal((await call("tasks/" + a, "DELETE")).status, 204);
	assert.equal(task.parse(await (await call("tasks/" + child)).json()).parentId, null);

	const concurrent = await Promise.all([edge(b, c), edge(c, b)]);
	assert.deepEqual(concurrent.map((r) => r.status).sort(), [204, 409]);
}

export async function checkAccess() {
	const issuer = "https://planner.cloudflareaccess.com";
	const config = {
		ACCESS_ISSUER: issuer,
		ACCESS_AUD: "app-id",
		LOCAL_PLANNER: "disabled",
	} as const;
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const keys = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
	async function signed(aud: string, exp: number, iss = issuer) {
		return new SignJWT({})
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("alice")
			.setIssuer(iss)
			.setAudience(aud)
			.setExpirationTime(exp)
			.sign(privateKey);
	}
	const check = (token: string) =>
		identify(
			new Request("https://planner.test/api/tasks", {
				headers: {
					"Cf-Access-Jwt-Assertion": token,
					"Cf-Access-Authenticated-User-Email": "someone-else@example.org",
				},
			}),
			config,
			() => keys,
		);
	const expiry = Math.floor(Date.now() / 1000) + 300;
	assert.equal(await check(await signed(config.ACCESS_AUD, expiry)), issuer + "/alice");
	for (const token of [
		"",
		"bad",
		await signed("other", expiry),
		await signed(config.ACCESS_AUD, 1),
		await signed(config.ACCESS_AUD, expiry, "https://elsewhere.test"),
	]) {
		const result = await check(token);
		assert.ok(result instanceof Response && result.status === 401);
	}
	const unauthenticated = await identify(new Request("http://localhost/api/tasks"), config);
	assert.ok(unauthenticated instanceof Response && unauthenticated.status === 401);
}
