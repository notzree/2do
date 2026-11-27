import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderQuestion, providerFormValues, providerUrl } from "./provider-question.tsx";
import { defaultReplyTarget, itemReplyTarget, routeChatReply } from "./agent-inbox-api.ts";
import type { InboxItem } from "@2do/api/agent-inbox";

const request = {
  mode: "form" as const,
  provider: "Test calendar",
  message: "Choose what to attach",
  fields: [
    { name: "count", label: "Count", type: "integer" as const, required: true, min: 1, max: 10 },
    { name: "include", label: "Include details", type: "boolean" as const, required: true },
    { name: "optional", label: "Optional note", type: "string" as const, required: false },
    {
      name: "color",
      label: "Color",
      type: "string" as const,
      required: true,
      options: ["blue", "red"],
    },
  ],
};
it("previews typed provider fields and transmits data only when the user submits", () => {
  const html = renderToStaticMarkup(
    <ProviderQuestion
      request={request}
      busy={false}
      respond={() => {
        throw new Error("Unexpected transmission");
      }}
    />,
  );
  expect(html).toContain("Test calendar");
  expect(html).toContain('type="number"');
  expect(html).toContain("Decline");
  expect(html).toContain("Cancel");
  const input = new FormData();
  input.set("count", "4");
  input.set("include", "false");
  input.set("optional", "");
  input.set("color", "red");
  expect(providerFormValues(request.fields, input)).toEqual({
    count: 4,
    include: false,
    color: "red",
  });
});
it("opens only the displayed HTTPS host and keeps provider consent out of plain chat replies", () => {
  expect(providerUrl("https://example.com/consent", "example.com")).toBe(
    "https://example.com/consent",
  );
  expect(providerUrl("https://elsewhere.example/consent", "example.com")).toBeUndefined();
  expect(providerUrl("https://user@example.com/consent", "example.com")).toBeUndefined();
  const item: InboxItem = {
    id: "q",
    kind: "question",
    title: "Provider",
    body: request.message,
    createdAt: "2027-03-01",
    read: true,
    archived: false,
    changes: [],
    choices: [],
    status: "pending",
    version: 1,
    conversation: "me",
    elicitation: request,
  };
  expect(defaultReplyTarget([item], "me")).toEqual({ kind: "message" });
  expect(routeChatReply("accept", [item], "me", itemReplyTarget(item)).kind).toBe("blocked");
});
