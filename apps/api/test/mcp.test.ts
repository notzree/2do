import { env } from "cloudflare:test";
import { createMcpConnection } from "@flue/runtime";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vite-plus/test";
import { plannerConnection } from "../src/mcp/connection.ts";
import { plannerOperations } from "../src/routes/contract.ts";

it("mounts every opted-in operation through Flue's MCP connection", async () => {
	const connection = await createMcpConnection(
		plannerConnection(env.USER_PLANNER, crypto.randomUUID()),
	);
	try {
		const expected = Object.values(plannerOperations)
			.filter((op) => "x-mcp" in op && op["x-mcp"])
			.map((op) => "mcp__planner__" + op.operationId);
		expect(connection.tools.map((tool) => tool.name).sort()).toEqual(expected.sort());
	} finally {
		await connection.close();
	}
});

it("routes MCP writes, reads and errors to the conversation owner's planner", async () => {
	async function connect(identity: string) {
		const config = plannerConnection(env.USER_PLANNER, identity);
		const client = new Client({ name: "planner-test", version: "1" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(config.url), { fetch: config.fetch }),
		);
		return client;
	}

	const owner=crypto.randomUUID();
	const [alice, bob] = await Promise.all([
		connect(owner),
		connect(crypto.randomUUID()),
	]);
	try {
		const id = crypto.randomUUID();
		const create = await alice.callTool({
			name: "createTask",
			arguments: { requestBody: { id, title: "Plan lunch" } },
		});
		expect(create.isError).toBeFalsy();
		const stub=env.USER_PLANNER.getByName(owner);
		async function approve(result:typeof create) {
			const item=JSON.parse((result.content[0] as {text:string}).text);
			expect(item).toMatchObject({status:"pending",kind:"proposal"});
			const res=await stub.fetch("https://planner.test/api/agent/inbox/"+item.id+"/decision",{
				method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({decision:"approve",version:item.version})
			});
			expect(await res.json()).toMatchObject({status:"applied"});
		}
		expect((await stub.fetch("https://planner.test/api/tasks/"+id)).status).toBe(404);
		await approve(create);
		const created = await (await stub.fetch("https://planner.test/api/tasks/"+id)).json<{revision:number}>();
		const update = await alice.callTool({
			name: "updateTask",
			arguments: { id, requestBody: { completed: true, revision: created.revision } },
		});
		expect(update.isError).toBeFalsy();
		await approve(update);
		const changed = await alice.callTool({
			name: "updateTask",
			arguments: { id, requestBody: { title: "Stale edit", revision: created.revision } },
		});
		expect(changed.isError).toBe(true);
		const found = await alice.callTool({
			name: "searchTasks",
			arguments: { requestBody: { title: "lunch", completed: true } },
		});
		expect(JSON.parse((found.content[0] as { text: string }).text)).toMatchObject({
			tasks: [{ id, title: "Plan lunch" }],
			nextCursor: null,
		});
		const result = await alice.callTool({ name: "getTask", arguments: { id } });
		expect(result.content).toEqual([
			{ type: "text", text: expect.stringContaining('"completed":true') },
		]);
		expect((await bob.callTool({ name: "getTask", arguments: { id } })).isError).toBe(true);
		expect((await alice.callTool({ name: "getTask", arguments: {} })).isError).toBe(true);
		const removed = await alice.callTool({
			name: "deleteTask",
			arguments: { id, withPages: "true" },
		});
		await approve(removed);
		expect((await stub.fetch("https://planner.test/api/tasks/"+id)).status).toBe(404);
	} finally {
		await Promise.all([alice.close(), bob.close()]);
	}
});
