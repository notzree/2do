import { describe, it, expect } from "vitest";
import type { FlueConversationMessage, FlueConversationPart } from "@flue/sdk";
import type { InboxItem } from "@2do/api/agent-inbox";
import {
  defaultReplyTarget,
  itemReplyTarget,
  routeChatReply,
  toolInboxItem,
} from "./agent-inbox-api.ts";
import {
  incomingDeviceCalls,
  executeDeviceCalls,
  resolveDeviceChange,
  useDeviceReceipts,
} from "./agent-workspace.ts";
import { defaults } from "./preferences.ts";
import { usePreferences } from "./preference-store.ts";

const item: InboxItem = {
  id: "item-1",
  conversation: "me",
  kind: "proposal",
  status: "pending",
  version: 3,
  read: true,
  archived: false,
  title: "Edit",
  body: "",
  createdAt: "2027-01-01",
  changes: [],
  choices: [],
};
describe("chat inbox decisions", () => {
  const question: InboxItem = { ...item, kind: "question", choices: ["Thursday", "Friday"] };
  const route = (text: string, items: InboxItem[], target = defaultReplyTarget(items, "me")) =>
    routeChatReply(text, items, "me", target);
  it("binds typed approvals to one displayed pending proposal in this conversation", () => {
    expect(route("Approve it.", [item])).toEqual({
      kind: "decision",
      value: { id: item.id, body: { version: 3, decision: "approve" } },
    });
    expect(route("Approve", [item, { ...item, id: "b" }]).kind).toBe("blocked");
    expect(route("Can I approve it?", [item]).kind).toBe("message");
    expect(route("Make it 4:30 instead", [item])).toEqual({
      kind:"decision",value:{id:item.id,body:{version:3,decision:"revise",answer:"Make it 4:30 instead"}},
    });
    expect(route("Talk about Thursday",[item],{kind:"message"})).toEqual({kind:"message"});
    expect(route("Approve", [{ ...item, status: "applied" }]).kind).toBe("message");
    expect(route("Approve", [{ ...item, conversation: "another-chat" }]).kind).toBe("message");
  });
  it("records a free-text response and preserves paraphrases for the resumed workflow", () => {
    for (const [text, choices] of [
      ["Next week, after my meeting", []],
      ["the one on Friday, please", ["Thursday", "Friday"]],
    ] as const) {
      expect(route(text, [{ ...question, choices: [...choices] }])).toEqual({
        kind: "decision",
        value: { id: item.id, body: { version: 3, decision: "answer", answer: text } },
      });
    }
    expect(route("friday", [question])).toEqual({
      kind: "decision",
      value: { id: item.id, body: { version: 3, decision: "answer", answer: "Friday" } },
    });
  });
  it("requires a target for concurrent questions and lets the user start an unrelated message", () => {
    const second = { ...question, id: "b" };
    expect(route("Friday", [question, second]).kind).toBe("blocked");
    expect(route("Friday", [question, second], itemReplyTarget(second))).toEqual({
      kind: "decision",
      value: { id: "b", body: { version: 3, decision: "answer", answer: "Friday" } },
    });
    expect(route("new topic", [question, second], { kind: "message" }).kind).toBe("message");
    expect(route("new topic", []).kind).toBe("message");
  });
  it("retains a drafted answer when its bound item is stale, resolved, or belongs to another chat", () => {
    const bound = itemReplyTarget(question);
    for (const unavailable of [
      { ...question, version: 4 },
      { ...question, status: "answered" as const },
      { ...question, conversation: "other" },
    ]) {
      expect(route("Friday", [unavailable], bound).kind).toBe("blocked");
    }
  });
  it("reads the formatted JSON string returned by Flue MCP and ignores ordinary results", () => {
    const output = (value: unknown): FlueConversationPart => ({
      type: "dynamic-tool",
      toolName: "mcp__planner__updateTask",
      toolCallId: "1",
      state: "output-available",
      input: {},
      output: value,
    });
    expect(toolInboxItem(output(JSON.stringify(item)))).toBe(item.id);
    expect(toolInboxItem(output({ content: [{ type: "text", text: JSON.stringify(item) }] }))).toBe(
      item.id,
    );
    expect(
      toolInboxItem(output(JSON.stringify({ id: item.id, title: "A regular task" }))),
    ).toBeUndefined();
  });
});

function message(
  submissionId: string,
  action: unknown,
  tool = "showWorkspace",
): FlueConversationMessage {
  return {
    role: "assistant",
    submissionId,
    parts: [
      {
        type: "dynamic-tool",
        toolName: tool,
        toolCallId: "test-" + submissionId,
        input: {},
        state: "output-available",
        output: { status: "awaiting_device", clientCommand: action },
      },
    ],
  } as FlueConversationMessage;
}
describe("originating browser commands", () => {
  it("accepts only a command emitted by the workspace tool in the submitted turn", () => {
    const action = { command: "calendar", date: "2027-03-05" };
    expect(
      incomingDeviceCalls(
        [
          message("a", action),
          message("b", action),
          message("a", action, "mcp__planner__readPage"),
        ],
        "a",
      ),
    ).toEqual([{ id: "test-a", action }]);
    expect(
      incomingDeviceCalls([message("a", { command: "open_url", url: "https://example.com" })], "a"),
    ).toEqual([]);
  });
  it("previews device edits, rejects stale approval and records repeated delivery once", () => {
    usePreferences.setState(defaults);
    const messages = [message("prefs", { command: "appearance", mode: "light" })];
    executeDeviceCalls(incomingDeviceCalls(messages, "prefs"), usePreferences.getState(), "");
    expect(usePreferences.getState().mode).toBe("dark");
    expect(useDeviceReceipts.getState().receipts["test-prefs"].status).toBe("waiting");
    usePreferences.setState({ mode: "system" });
    resolveDeviceChange("test-prefs", true);
    expect(usePreferences.getState().mode).toBe("system");
    executeDeviceCalls(incomingDeviceCalls(messages, "prefs"), usePreferences.getState(), "");
    expect(useDeviceReceipts.getState().receipts["test-prefs"].status).toBe("unavailable");
  });
});

it("opens only source links issued for Gmail records", async () => {
  const { gmailSourceLink } = await import("./agent-inbox-api.ts");
  expect(gmailSourceLink("https://mail.google.com/mail/?authuser=x#all/thread")).toContain(
    "#all/thread",
  );
  expect(gmailSourceLink("https://mail.google.com.evil.invalid/mail/")).toBeUndefined();
  expect(gmailSourceLink("https://user:password@mail.google.com/mail/")).toBeUndefined();
  expect(gmailSourceLink("javascript:alert(1)")).toBeUndefined();
});
