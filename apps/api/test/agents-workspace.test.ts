import { env, runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vite-plus/test";
import type { UserPlanner } from "../src/user-planner.ts";
import { stableInboxKey } from "../src/core/agent-keys.ts";
import { AgentsWorkspace } from "../src/core/agents-workspace.ts";
import { contextMatches } from "../src/interfaces/agents-workspace.ts";
import { sideConversation } from "../src/agents/chat-identity.ts";
import { plannerConnection, setAgentTurn } from "../src/mcp/connection.ts";
import { inboxItem, inboxPage } from "../src/interfaces/agent-inbox.ts";

function workspace() {
  const owner = crypto.randomUUID();
  const planner = (env.USER_PLANNER as unknown as DurableObjectNamespace<UserPlanner>).getByName(
    owner,
  );
  const request = (path: string, method = "GET", body?: object) =>
    planner.fetch("https://test/api/" + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
    });
  async function read<T>(path: string, method = "GET", body?: object) {
    const response = await request(path, method, body);
    expect(response.ok, method + " " + path + " returned " + response.status).toBe(true);
    return response.json<T>();
  }
  async function register(title: string) {
    const id = crypto.randomUUID();
    await read("chats/" + id, "PUT", { title });
    return id;
  }
  async function inChat<T>(
    id: string,
    run: (client: Client) => Promise<T>,
    submission: string = crypto.randomUUID(),
  ) {
    const address = id === "me" ? owner : sideConversation(owner, id);
    const config = plannerConnection(env.USER_PLANNER, owner, address);
    const client = new Client({ name: "workspace-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.url), { fetch: config.fetch }),
    );
    setAgentTurn(address, { origin: "chat", submission });
    try {
      return await run(client);
    } finally {
      setAgentTurn(address, undefined);
      await client.close();
    }
  }
  return { owner, planner, request, read, register, inChat };
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, (result.content[0] as { text?: string })?.text).toBeFalsy();
  return JSON.parse((result.content[0] as { text: string }).text) as unknown;
}

it("lets a fresh side chat discover and reference an archived chat's proposal, then resolves the same durable record once", async () => {
  const w = workspace();
  const origin = await w.register("Physics planning");
  const task = await w.read<{ id: string; revision: number }>("tasks", "POST", {
    title: "Orbital mechanics",
  });
  const proposed = await w.inChat(origin, async (client) =>
    inboxItem.parse(
      await tool(client, "updateTask", {
        id: task.id,
        requestBody: { revision: task.revision, title: "Orbital mechanics exercises" },
      }),
    ),
  );
  expect(proposed).toMatchObject({ status: "pending", conversation: origin });
  await w.read("chats/" + origin, "PATCH", { archived: true });
  const fresh = await w.register("Exam checklist");

  // Neither side has a Flue transcript. All discovery and review data must come from the workspace.
  await w.read("agent/questions", "POST", { title: "Orbital mechanics", body: "Which session?" });
  await w.read("agent/changes", "POST", {
    id: crypto.randomUUID(),
    title: "Reading list",
    reason: "Unrelated proposal",
    steps: [
      {
        operation: "createTask",
        args: { requestBody: { id: crypto.randomUUID(), title: "Read" } },
      },
    ],
  });
  const scoped = "agent/inbox?chat=" + fresh + "&view=action";
  expect(inboxPage.parse(await w.read(scoped)).items).toEqual([]);
  await w.inChat(fresh, async (client) => {
    const result = inboxPage.parse(
      await tool(client, "listAgentInbox", {
        view: "action",
        kind: "proposal",
        q: "Orbital mechanics",
      }),
    );
    expect(result.items.map((i) => i.id)).toEqual([proposed.id]);
    const retrieved = inboxItem.parse(
      await tool(client, "readAgentInboxItem", { id: proposed.id }),
    );
    expect(retrieved.changes).toEqual(proposed.changes);
    const linked = inboxItem.parse(
      await tool(client, "linkWorkspaceItem", { id: "current", itemId: proposed.id }),
    );
    expect(linked.id).toBe(proposed.id);
    const crossChat = await client.callTool({
      name: "linkWorkspaceItem",
      arguments: { id: origin, itemId: proposed.id },
    });
    expect(crossChat.isError).toBe(true);
  });
  for (let retry = 0; retry < 2; retry++)
    expect((await w.request("chats/" + fresh + "/items/" + proposed.id, "PUT")).ok).toBe(true);
  expect(inboxPage.parse(await w.read(scoped)).items.map((i) => i.id)).toEqual([proposed.id]);
  const decide = () =>
    w.read("agent/inbox/" + proposed.id + "/decision", "POST", {
      version: proposed.version,
      decision: "approve",
    });
  const [first, retry] = await Promise.all([decide(), decide()]);
  for (const decision of [first, retry])
    expect(decision).toMatchObject({ id: proposed.id, status: "applied" });
  expect(await w.read("tasks/" + task.id)).toMatchObject({
    title: "Orbital mechanics exercises",
    revision: task.revision + 1,
  });
  expect(inboxPage.parse(await w.read(scoped)).items).toEqual([]);
  expect(
    inboxPage.parse(await w.read("agent/inbox?chat=" + origin + "&view=action")).items,
  ).toEqual([]);
  expect(inboxItem.parse(await w.read("agent/inbox/" + proposed.id))).toMatchObject({
    id: proposed.id,
    status: "applied",
  });
});

it("finds an unreferenced proposal by workspace ID and isolates activity and links per owner", async () => {
  const alice = workspace(),
    bob = workspace();
  const planned = inboxItem.parse(
    await alice.read("agent/changes", "POST", {
      id: crypto.randomUUID(),
      title: "Join writing workshop",
      reason: "Reserve time",
      steps: [
        {
          operation: "createTask",
          args: { requestBody: { id: crypto.randomUUID(), title: "Writing workshop" } },
        },
      ],
    }),
  );
  const a = await alice.register("Writing"),
    b = await bob.register("Writing");
  const search = { view: "action", kind: "proposal", q: "writing workshop" };
  const aliceResult = await alice.inChat(a, async (c) =>
    inboxPage.parse(await tool(c, "listAgentInbox", search)),
  );
  expect(aliceResult.items.map((item) => item.id)).toEqual([planned.id]);
  const bobResult = await bob.inChat(b, async (c) =>
    inboxPage.parse(await tool(c, "listAgentInbox", search)),
  );
  expect(bobResult.items).toEqual([]);
  expect((await bob.request("agent/inbox/" + planned.id)).status).toBe(404);
  expect((await bob.request("chats/" + b + "/items/" + planned.id, "PUT")).status).toBe(404);
  expect((await alice.request("chats/" + b + "/items/" + planned.id, "PUT")).status).toBe(404);
  type ActivityPage = {
    items: { id: string; chat: string; itemId?: string; at: string }[];
    nextCursor: string | null;
  };
  const activities = await alice.read<ActivityPage>("agents/activity");
  expect(activities.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ chat: "me", itemId: planned.id })]),
  );
  expect(
    (await bob.read<ActivityPage>("agents/activity")).items.some(
      (item) => item.itemId === planned.id,
    ),
  ).toBe(false);
});

it("searches only the transcript sources granted to the current submission, in both directions", async () => {
  const w = workspace();
  const trip = await w.register("Trip budget");
  const study = await w.register("Study budget");
  const old = await w.register("Archived budget");
  await w.read("chats/" + old, "PATCH", { archived: true });
  const mainTurn = crypto.randomUUID(),
    sideTurn = crypto.randomUUID(),
    allTurn = crypto.randomUUID();
  await runInDurableObject(w.planner, (_, { storage }) => {
    for (const [chat, phrase] of [
      ["me", "Shared budget in Main"],
      [trip, "Trip budget in January"],
      [study, "Study budget in February"],
      [old, "Archived budget"],
    ]) {
      storage.sql.exec(
        "INSERT INTO agent_message(chat,generation,messageId,text,at) VALUES(?,?,?,?,?)",
        chat,
        "g1",
        "msg-" + chat,
        phrase,
        "2026-11-27T12:30:00Z",
      );
    }
    const workspace = new AgentsWorkspace(storage.sql);
    workspace.grant("me", mainTurn, [trip]);
    workspace.grant("me", allTurn, ["active-sides"]);
    workspace.grant(trip, sideTurn, ["me"]);
  });
  await w.inChat(
    "me",
    async (client) => {
      const results = contextMatches.parse(
        await tool(client, "searchConversationContext", { q: "budget" }),
      );
      expect(results).toMatchObject([{ chat: trip, messageId: "msg-" + trip, generation: "g1" }]);
      const outside = await client.callTool({
        name: "searchConversationContext",
        arguments: { q: "budget", chat: study },
      });
      expect(outside.isError).toBe(true);
    },
    mainTurn,
  );
  await w.inChat(
    "me",
    async (client) => {
      const results = contextMatches.parse(
        await tool(client, "searchConversationContext", { q: "budget" }),
      );
      expect(results.map((r) => r.chat).sort()).toEqual([study, trip].sort());
      const archived = await client.callTool({
        name: "searchConversationContext",
        arguments: { q: "budget", chat: old },
      });
      expect(archived.isError).toBe(true);
    },
    allTurn,
  );
  await w.inChat(
    trip,
    async (client) => {
      expect(
        contextMatches.parse(await tool(client, "searchConversationContext", { q: "budget" })),
      ).toMatchObject([{ chat: "me", excerpt: "Shared budget in Main" }]);
    },
    sideTurn,
  );
  await w.inChat(trip, async (client) => {
    expect(
      (
        await client.callTool({
          name: "searchConversationContext",
          arguments: { q: "budget", chat: "me" },
        })
      ).isError,
    ).toBe(true);
  });
});

it("records one milestone at both ends, rejects conflicting retries, and keeps activity pages stable", async () => {
  const w = workspace(),
    side = await w.register("Trip");
  const path = "chats/" + side + "/milestones";
  const report = {
    occurrence: "booking-final",
    title: "Accommodation selected",
    body: "The group selected a Waikiki apartment.",
  };
  const first = await w.read<{ id: string }>(path, "POST", report);
  expect(await w.read(path, "POST", report)).toEqual(first);
  expect((await w.request(path, "POST", { ...report, body: "Different outcome" })).status).toBe(
    409,
  );
  const list = (query: string) =>
    w.read<{
      items: { id: string; kind: string; chat: string; relatedChat: string }[];
      nextCursor: string | null;
    }>("agents/activity?" + query);
  expect((await list("chat=me")).items.filter((item) => item.kind === "milestone")).toMatchObject([
    { id: first.id, chat: "me", relatedChat: side },
  ]);
  expect(
    (await list("chat=" + side)).items.filter((item) => item.kind === "milestone"),
  ).toMatchObject([{ chat: side, relatedChat: "me" }]);
  const newest = await list("limit=1");
  expect(newest.nextCursor).toBeTruthy();
  await w.read(path, "POST", {
    ...report,
    occurrence: "directions-final",
    title: "Directions ready",
  });
  const older = await list("limit=30&cursor=" + encodeURIComponent(newest.nextCursor!));
  expect(older.items.map((item) => item.id)).not.toContain(newest.items[0].id);
  expect(older.items.filter((item) => item.kind === "milestone")).toHaveLength(1);
});

it("publishes a device preview globally and accepts only its originating tab's reviewed outcome", async () => {
  const w = workspace(),
    chat = await w.register("Workspace setup");
  const claim = crypto.randomUUID(),
    submissionId = crypto.randomUUID(),
    toolCallId = crypto.randomUUID();
  const changes = [{ field: "Week start", before: "Sunday", after: "Monday" }];
  const base = { claim, submissionId, toolCallId, label: "Start week on Monday" };
  const preview = { ...base, status: "preview" as const, changes };
  const receive = (input: Parameters<UserPlanner["receiveDevicePreview"]>[2]) =>
    w.planner.receiveDevicePreview(w.owner, chat, input);
  expect((await receive(preview)).status).toBe(409);
  const hash = await stableInboxKey([claim]);
  await runInDurableObject(w.planner, (_, { storage }) => {
    storage.sql.exec(
      "INSERT INTO agent_device_origin(chat,submission,claim) VALUES(?,?,?)",
      chat,
      submissionId,
      hash,
    );
  });
  expect((await receive({ ...preview, claim: crypto.randomUUID() })).status).toBe(403);
  const published = await receive(preview);
  expect(published.status).toBe(202);
  const { itemId } = await published.json<{ itemId: string }>();
  expect(await (await receive(preview)).json()).toMatchObject({ itemId });
  expect(
    (await receive({ ...preview, changes: [{ ...changes[0], after: "Tuesday" }] })).status,
  ).toBe(409);
  const itemPath = "agent/inbox/" + itemId;
  expect(await w.read("agent/inbox?view=action")).toMatchObject({
    needsAction: 1,
    items: [{ id: itemId, source: "device", status: "pending", conversation: chat, changes }],
  });
  expect(
    (await w.request(itemPath + "/decision", "POST", { version: 1, decision: "approve" })).status,
  ).toBe(403);
  expect((await receive({ ...base, status: "applied" })).status).toBe(409);
  expect((await receive({ ...base, status: "authorize", claim: crypto.randomUUID() })).status).toBe(
    403,
  );
  expect((await receive({ ...base, status: "authorize" })).status).toBe(202);
  expect(await w.read(itemPath)).toMatchObject({ id: itemId, status: "queued" });
  expect((await receive({ ...base, status: "applied", claim: crypto.randomUUID() })).status).toBe(
    403,
  );
  expect((await receive({ ...base, status: "applied" })).status).toBe(202);
  expect((await receive({ ...base, status: "applied" })).status).toBe(202);
  expect((await receive({ ...base, status: "rejected" })).status).toBe(409);
  expect(await w.read(itemPath)).toMatchObject({ id: itemId, status: "applied" });
  expect(await w.read("agent/inbox?view=action")).toMatchObject({ needsAction: 0, items: [] });
  const feed = await w.read<{ items: { itemId: string; body: string }[] }>("agents/activity");
  expect(feed.items.filter((e) => e.itemId === itemId && e.body === "applied")).toHaveLength(1);
});
