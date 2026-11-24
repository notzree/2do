import { env } from "cloudflare:test";
import { createMcpConnection } from "@flue/runtime";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vite-plus/test";
import { plannerConnection } from "../src/mcp/connection.ts";
import { operations } from "../src/routes/contract.ts";

it("mounts every opted-in operation through Flue's MCP connection", async () => {
	const connection = await createMcpConnection(
		plannerConnection(env.USER_PLANNER, crypto.randomUUID()),
	);
	try {
		const expected = Object.entries(operations)
			.filter(([, op]) => "mcp" in op && op.mcp)
			.map(([name]) => "mcp__planner__" + name);
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

	const [alice, bob] = await Promise.all([
		connect(crypto.randomUUID()),
		connect(crypto.randomUUID()),
	]);
	try {
		const id = crypto.randomUUID();
		const create = await alice.callTool({
			name: "createTask",
			arguments: { requestBody: { id, title: "Plan lunch" } },
		});
		expect(create.isError).toBeFalsy();
		const update = await alice.callTool({
			name: "updateTask",
			arguments: { id, requestBody: { completed: true } },
		});
		expect(update.isError).toBeFalsy();
		const result = await alice.callTool({ name: "getTask", arguments: { id } });
		expect(result.content).toEqual([
			{ type: "text", text: expect.stringContaining('"completed":true') },
		]);
		expect((await bob.callTool({ name: "getTask", arguments: { id } })).isError).toBe(true);
		expect((await alice.callTool({ name: "getTask", arguments: {} })).isError).toBe(true);
	} finally {
		await Promise.all([alice.close(), bob.close()]);
	}
});
