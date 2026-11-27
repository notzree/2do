import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSendResult, FlueClient } from "@flue/sdk";
import { defaults } from "./preferences.ts";

const pageUrl = "https://planner.test/app/week";
const owner = "owner-a";
const state = vi.hoisted(() => ({ scope: "owner-a" }));
vi.mock("./query.ts", () => ({ getVerifiedScope: () => state.scope }));
const receipt = {
  submissionId: "submitted-1",
  streamUrl: pageUrl,
  uid: "u",
  acceptedAt: new Date().toISOString(),
  offset: "1",
} as AgentSendResult;
function client(action: object) {
  return {
    wait: vi.fn(async () => {}),
    history: vi.fn(async () => ({
      messages: [
        {
          role: "assistant",
          submissionId: receipt.submissionId,
          parts: [
            {
              type: "dynamic-tool",
              state: "output-available",
              toolName: "showWorkspace",
              toolCallId: "call-1",
              output: { status: "awaiting_device", clientCommand: action },
            },
          ],
        },
      ],
    })),
  } as unknown as FlueClient;
}
let records: Map<string, string>;
let lockHeld: Set<string>;
function browserStorage() {
  return {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
  };
}
beforeEach(() => {
  vi.resetModules();
  records = new Map();
  lockHeld = new Set();
  state.scope = owner;
  vi.stubGlobal("location", new URL(pageUrl));
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({accepted:true,itemId:"device-test"},{status:202})),
  );
  vi.stubGlobal("sessionStorage", browserStorage());
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        name: string,
        _options: unknown,
        fn: (lock: object | null) => Promise<void>,
      ) => {
        if (lockHeld.has(name)) return fn(null);
        lockHeld.add(name);
        await fn({});
        lockHeld.delete(name);
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
async function reload() {
  window.dispatchEvent(new Event("pagehide"));
  await Promise.resolve();
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
  return import("./device-delivery.ts");
}
it("restores pending submissions and preference diffs, sends a scoped receipt and deduplicates replay", async () => {
  const api = await import("./device-delivery.ts");
  const transport = client({ command: "appearance", mode: "light" });
  const stalled = { ...transport, wait: () => new Promise(() => {}) } as unknown as FlueClient;
  void api.followDeviceSubmission(owner, "me", receipt, defaults, pageUrl, stalled);
  await vi.waitFor(() =>
    expect([...records.values()].some((v) => v.includes("submitted-1"))).toBe(true),
  );
  const recovered = await reload();
  await recovered.recoverDeviceSubmissions(owner, () => transport);
  let commands = await import("./agent-workspace.ts");
  expect(commands.useDeviceReceipts.getState().receipts["call-1"].status).toBe("waiting");
  const bodies=()=>vi.mocked(fetch).mock.calls.map(([,init])=>JSON.parse(String(init?.body)));
  await vi.waitFor(()=>expect(bodies().some(b=>b.status==="preview")).toBe(true));
  expect(bodies().every(b=>b.status==="preview" && b.claim)).toBe(true);

  const again = await reload();
  await again.recoverDeviceSubmissions(owner, () => transport);
  commands = await import("./agent-workspace.ts");
  await commands.resolveDeviceChange("call-1", true);
  await vi.waitFor(()=>expect(bodies().filter(b=>b.status==="applied")).toHaveLength(1));
  expect(bodies().filter(b=>b.status!=="preview").map(b=>b.status)).toEqual(["authorize","applied"]);
  const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!;
  expect(url).toBe("/api/chats/me/device-receipt");
  expect(JSON.parse(String(init?.body))).toMatchObject({
    toolCallId: "call-1",
    submissionId: "submitted-1",
    status: "applied",
  });
  expect(new Headers(init?.headers).get("X-Planner-Scope")).toBe(owner);
  await again.recoverDeviceSubmissions(owner, () => transport);
  expect(bodies().filter(b=>b.status==="applied")).toHaveLength(1);
});
it("isolates both a duplicated live tab and another planner from pending browser actions", async () => {
  const api = await import("./device-delivery.ts");
  const transport = client({ command: "appearance", mode: "light" });
  await api.followDeviceSubmission(owner, "me", receipt, defaults, pageUrl, transport);
  const originalId = records.get("2do.agent.tab");
  // Session storage contents are cloned when a user duplicates the original live tab.
  records = new Map(records);
  vi.resetModules();
  const duplicate = await import("./device-delivery.ts");
  const spy = vi.fn(() => transport);
  await duplicate.recoverDeviceSubmissions(owner, spy);
  expect(spy).not.toHaveBeenCalled();
  expect(records.get("2do.agent.tab")).not.toBe(originalId);
  state.scope = "owner-b";
  await duplicate.recoverDeviceSubmissions(state.scope, spy);
  expect(spy).not.toHaveBeenCalled();
});

it("recovers older device calls without reading history before the submitting message", async () => {
  const api = await import("./device-delivery.ts");
  const transport = client({ command: "appearance", mode: "light" });
  const snapshot = await transport.history();
  const tool = snapshot.messages[0];
  const source = { ...tool, role: "user" as const, purpose: "user" as const, parts: [] };
  vi.mocked(transport.history).mockClear().mockResolvedValue({
    ...snapshot, before: "older", messages: [{ ...tool, submissionId: "another-submission" }],
  });
  const older = vi.fn<FlueClient["historyBefore"]>().mockResolvedValue({
    v: 1, conversationId: "me", messages: [source, tool], before: "unrelated-history",
  });
  await api.followDeviceSubmission(owner, "me", receipt, defaults, pageUrl, { ...transport, historyBefore: older });
  expect(transport.history).toHaveBeenCalledExactlyOnceWith({ limit: 80 });
  expect(older).toHaveBeenCalledExactlyOnceWith("older", { limit: 80 });
  const { useDeviceReceipts } = await import("./agent-workspace.ts");
  expect(useDeviceReceipts.getState().receipts["call-1"].status).toBe("waiting");
});
