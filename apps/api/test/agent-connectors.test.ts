import { env, runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vite-plus/test";
import { connectorConnection } from "../src/connectors/agent-connection.ts";
import { type ConnectorEnv } from "../src/connectors/connection.ts";
import { connectorAgentToolNames } from "../src/connectors/inbox-actions.ts";
import { mailCandidate, gmailSource } from "../src/connectors/mail-candidate.ts";
import { inboxItem } from "../src/interfaces/agent-inbox.ts";
import { setAgentTurn } from "../src/mcp/connection.ts";

it("uses owner-scoped Google tools and queues exactly the reviewed change", async () => {
  const owner = crypto.randomUUID();
  const bindings = env as unknown as ConnectorEnv;
  const planner = bindings.USER_PLANNER.getByName(owner);
  const calendar = bindings.GOOGLE_CONNECTION.getByName("google-calendar/" + planner.id);
  const directions = { importEvents: true, exportEvents: false };
  await runInDurableObject(calendar, async (_, ctx) => {
    ctx.storage.kv.put("grant", {
      kind: "google-calendar",
      email: "fixture@example.org",
      planner: planner.id.toString(),
      generation: "fixture",
      permissions: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      options: directions,
    });
  });
  const transport = connectorConnection(env, owner, owner);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(transport.url), { fetch: transport.fetch }),
  );
  try {
    setAgentTurn(owner, { origin: "chat", submission: crypto.randomUUID() });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      [...connectorAgentToolNames].sort(),
    );
    const request = {
      name: "calendarSyncDirections",
      arguments: { requestBody: { importEvents: false, exportEvents: false } },
    };
    const call = async () => {
      const result = await client.callTool(request);
      expect(result.isError).toBeFalsy();
      return inboxItem.parse(JSON.parse((result.content[0] as { text: string }).text));
    };
    const candidate = await call();
    expect((await call()).id).toBe(candidate.id);
    expect(candidate.status).toBe("pending");
    expect((await calendar.status("google-calendar")).directions).toEqual(directions);
    const accepted = await planner.fetch(
      "https://test/api/agent/inbox/" + candidate.id + "/decision",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: candidate.version, decision: "approve" }),
      },
    );
    expect(await accepted.json()).toMatchObject({ status: "queued" });
    await runInDurableObject(planner, async (instance) => {
      await instance.alarm();
    });
    expect((await calendar.status("google-calendar")).directions.importEvents).toBe(false);
    const other = bindings.USER_PLANNER.getByName(crypto.randomUUID());
    expect((await other.fetch("https://test/api/agent/inbox/" + candidate.id)).status).toBe(404);
  } finally {
    setAgentTurn(owner, undefined);
    await client.close();
  }
});

it("extracts bounded task evidence and deduplicates approved mail candidates", async () => {
  const input = {
    subject: "Workshop",
    snippet: "Please book the room for Thursday.",
    receivedAt: Date.now(),
  };
  const fixtureModel = (value: string | null) =>
    ({ run: async () => Response.json({ answers: { f0: { valid: true, value } } }) });
  const candidate = await mailCandidate(fixtureModel("book the room"), input);
  expect(candidate?.title).toBe("book the room");
  expect(await mailCandidate(fixtureModel("call someone else"), input)).toBeNull();
  expect(await mailCandidate(fixtureModel(null), input)).toBeNull();
  const planner = (env as unknown as ConnectorEnv).USER_PLANNER.getByName(crypto.randomUUID());
  const source = gmailSource("fixture@example.org", { id: "123", threadId: "456" });
  const proposal = { ...candidate!, id: "gmail-stable", source };
  await planner.proposeMailTask(proposal);
  await planner.proposeMailTask(proposal);
  const inbox = await (
    await planner.fetch("https://test/api/agent/inbox?view=action")
  ).json<{ items: unknown[] }>();
  expect(inbox.items).toHaveLength(1);
  const item = inboxItem.parse(inbox.items[0]);
  const decision = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: item.version, decision: "approve" }),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await planner.fetch(
      "https://test/api/agent/inbox/" + item.id + "/decision",
      decision,
    );
    expect(await response.json()).toMatchObject({ status: "applied" });
  }
  expect(
    (await (await planner.fetch("https://test/api/tasks")).json<{ tasks: unknown[] }>()).tasks,
  ).toHaveLength(1);
});
