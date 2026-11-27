import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Server, createMcpHandler, inputRequired } from "@modelcontextprotocol/server";
import { expect, it } from "vite-plus/test";
import { runElicitingTool, type ElicitingProvider } from "../src/mcp/elicitation-client.ts";
import { validateElicitationReply } from "../src/interfaces/elicitation.ts";
import { connectionGuide, guideTool } from "../src/connectors/connection-guide.ts";
import type { ConnectorEnv } from "../src/connectors/connection.ts";
import { inboxItem } from "../src/interfaces/agent-inbox.ts";

it("negotiates, presents form and URL, and resumes on fresh SDK clients after explicit consent", async () => {
  let connected = false;
  const provider = connectionGuide("https://planner.example", async (kind) => ({
    configured: true,
    account: kind === "gmail" && connected ? "example@example.test" : null,
  }));
  const start = { workflow: "fixture", tool: guideTool, args: {} };
  const first = await runElicitingTool(provider, start);
  if (first.kind !== "question") throw new Error("Expected form");
  expect(first.view).toMatchObject({
    mode: "form",
    provider: "2do Google Connections",
    fields: [{ name: "service", options: ["gmail", "google-calendar", "google-health"] }],
  });
  expect(() =>
    validateElicitationReply(first.view, { action: "accept", values: { service: "other" } }),
  ).toThrow();
  const chosen = { action: "accept" as const, values: { service: "gmail" } };
  const next = await runElicitingTool(provider, start, {
    continuation: first.continuation,
    reply: chosen,
  });
  if (next.kind !== "question") throw new Error("Expected URL");
  expect(next.view).toMatchObject({ mode: "url", host: "planner.example" });
  const confirm = { continuation: next.continuation, reply: { action: "accept" as const } };
  expect(await runElicitingTool(provider, start, confirm)).toMatchObject({
    kind: "complete",
    text: expect.stringContaining("disconnected"),
  });
  connected = true;
  expect(await runElicitingTool(provider, start, confirm)).toMatchObject({
    kind: "complete",
    text: expect.stringContaining("example@example.test"),
  });
  for (const action of ["decline", "cancel"] as const)
    expect(
      await runElicitingTool(provider, start, {
        continuation: next.continuation,
        reply: { action },
      }),
    ).toMatchObject({ kind: "complete", text: expect.stringMatching(/declined|canceled/) });
});
it("rejects mismatched server identity, consent origin, and unregistered field requests", async () => {
  const handler = createMcpHandler(() => {
    const s = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
    s.setRequestHandler("tools/call", ({ params }) =>
      inputRequired({
        requestState: "opaque-token",
        inputRequests: {
          input: params.arguments?.url
            ? inputRequired.elicitUrl({
                url: "https://unregistered.example/consent",
                message: "Connect",
              })
            : inputRequired.elicit({
                message: "Input",
                requestedSchema: { type: "object", properties: { unexpected: { type: "string" } } },
              }),
        },
      }),
    );
    return s;
  });
  const p: ElicitingProvider = {
    id: "fixture",
    name: "Fixture provider",
    endpoint: new URL("https://fixture.internal/mcp"),
    tools: new Map([["read", { replay: "read-only", fields: new Set(["name"]) }]]),
    consentOrigins: new Set(["https://planner.example"]),
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  };
  const start = { workflow: "fixture", tool: "read", args: {} };
  await expect(runElicitingTool({ ...p, id: "other" }, start)).rejects.toThrow(/identity/);
  await expect(runElicitingTool(p, { ...start, args: { url: true } })).rejects.toThrow(
    /destination/,
  );
  await expect(runElicitingTool(p, start)).rejects.toThrow(/unregistered input/);
  await expect(runElicitingTool(p, { ...start, tool: "write" })).rejects.toThrow(/safely/);
});
it("recovers a negotiated provider form after planner eviction and records its response once", async () => {
  const owner = crypto.randomUUID();
  const planner = (env as unknown as ConnectorEnv).USER_PLANNER.getByName(owner);
  const item = inboxItem.parse(await planner.startConnectionGuide("same-turn", {}));
  const duplicate = inboxItem.parse(await planner.startConnectionGuide("same-turn", {}));
  expect(duplicate.id).toBe(item.id);
  expect(item.elicitation).toMatchObject({ mode: "form" });
  const base = "https://planner.internal/api/agent/inbox/" + item.id;
  expect(await (await planner.fetch(base)).json()).not.toHaveProperty("continuation");
  await evictDurableObject(planner);
  const decide = (reply: Record<string, unknown>) =>
    planner.fetch(base + "/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: item.version, decision: "answer", ...reply }),
    });
  expect((await decide({ answer: "guess" })).status).toBe(400);
  expect(
    (await decide({ elicitation: { action: "accept", values: { service: "bad" } } })).status,
  ).toBe(400);
  const cancel = { elicitation: { action: "cancel" } };
  expect((await decide(cancel)).status).toBe(200);
  await runInDurableObject(planner, async (p) => {
    await p.alarm();
  });
  expect(await (await planner.fetch(base)).json()).toMatchObject({
    status: "answered",
    answer: expect.stringContaining("canceled"),
  });
  expect((await decide(cancel)).status).toBe(200);
  expect((await decide({ elicitation: { action: "decline" } })).status).toBe(409);
});

it("follows a connector form through its durable URL card and verifies the provider outcome", async () => {
  const owner = crypto.randomUUID();
  const planner = (env as unknown as ConnectorEnv).USER_PLANNER.getByName(owner);
  const form = inboxItem.parse(await planner.startConnectionGuide("ask", {}));
  const path = (id: string) => "https://planner.internal/api/agent/inbox/" + id;
  const answer = (id: string, values?: Record<string, string>) =>
    planner.fetch(path(id) + "/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        decision: "answer",
        elicitation: { action: "accept", values },
      }),
    });
  expect(await (await answer(form.id, { service: "google-calendar" })).json()).toMatchObject({
    status: "queued",
  });
  await runInDurableObject(planner, async (p) => {
    await p.alarm();
  });
  const answered = inboxItem.parse(await (await planner.fetch(path(form.id))).json());
  expect(answered.status).toBe("answered");
  expect(answered.nextItemId).toBeTruthy();
  const url = inboxItem.parse(await (await planner.fetch(path(answered.nextItemId!))).json());
  expect(url.elicitation).toMatchObject({ mode: "url", host: "twodo.example" });
  await evictDurableObject(planner);
  expect((await answer(url.id)).status).toBe(200);
  await runInDurableObject(planner, async (p) => {
    await p.alarm();
  });
  expect(await (await planner.fetch(path(url.id))).json()).toMatchObject({
    status: "answered",
    answer: expect.stringContaining("still disconnected"),
  });
});
