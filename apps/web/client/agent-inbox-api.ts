import { queryOptions, useQuery } from "@tanstack/react-query";
import { inboxCounts, inboxItem, type InboxDecision, type InboxItem } from "@2do/api/agent-inbox";
import type { FlueConversationPart } from "@flue/sdk";
import { api, queryClient, refreshPlanner } from "./query.ts";

export type { InboxDecision } from "@2do/api/agent-inbox";
export const inboxKey = ["planner", "inbox"] as const;
const itemKey = (id: string) => [...inboxKey, "item", id];
export function useInboxCounts() {
  return useQuery({
    queryKey: [...inboxKey, "counts"],
    queryFn: async ({ signal }) => inboxCounts.parse((await api.GET("/api/agent/inbox-counts", { signal })).data),
    refetchInterval: 30_000,
  });
}
export const inboxItemQuery = (id: string) =>
  queryOptions({
    queryKey: itemKey(id),
    queryFn: async ({ signal }): Promise<InboxItem> => {
      const { data } = await api.GET("/api/agent/inbox/{id}", { params: { path: { id } }, signal });
      if (!data) throw new Error("Inbox item unavailable.");
      return inboxItem.parse(data);
    },
    refetchInterval: 20_000,
  });
export async function markItem(id: string, body: { read?: boolean; archived?: boolean }) {
  const { data } = await api.PATCH("/api/agent/inbox/{id}", { params: { path: { id } }, body });
  if (data) queryClient.setQueryData(itemKey(id), inboxItem.parse(data));
  await queryClient.invalidateQueries({ queryKey: inboxKey });
}
export async function decideItem(id: string, body: InboxDecision) {
  try {
    const { data } = await api.POST("/api/agent/inbox/{id}/decision", {
      params: { path: { id } },
      body,
    });
    if (data) queryClient.setQueryData(itemKey(id), inboxItem.parse(data));
  } finally {
    await refreshPlanner();
  }
}
export type ChatReplyTarget =
  | { kind: "question" | "proposal"; id: string; version: number; title: string }
  | { kind: "message" }
  | { kind: "choose" };

export function itemReplyTarget(item: InboxItem): ChatReplyTarget {
  return {
    kind: item.kind === "question" ? "question" : "proposal",
    id: item.id,
    version: item.version,
    title: item.title,
  };
}

export function defaultReplyTarget(items: InboxItem[], chatId: string): ChatReplyTarget {
  const pending = items.filter(
    (item) => item.status === "pending" && !item.elicitation && item.source!=="device" && (item.conversation === chatId || item.references?.includes(chatId)),
  );
  if (pending.length === 0) return { kind: "message" };
  if (pending.length === 1) return itemReplyTarget(pending[0]);
  return { kind: "choose" };
}

export type ChatDecision = { id: string; body: InboxDecision };
export type RoutedReply =
  | { kind: "decision"; value: ChatDecision }
  | { kind: "message" }
  | { kind: "blocked"; reason: string };
const explicitDecision = /^(approve|accept|reject|decline)( it)?[.!]?$/i;

export function routeChatReply(
  text: string,
  items: InboxItem[],
  chatId: string,
  target: ChatReplyTarget,
): RoutedReply {
  const value = text.trim();
  const pending = items.filter(
    (item) => item.status === "pending" && !item.elicitation && item.source!=="device" && (item.conversation === chatId || item.references?.includes(chatId)),
  );
  if (target.kind === "choose")
    return { kind: "blocked", reason: "Choose a question to answer or start a new message." };
  if (target.kind === "question") {
    const match = pending.find(
      (item) =>
        item.id === target.id && item.version === target.version && item.kind === "question",
    );
    if (!match)
      return {
        kind: "blocked",
        reason:
          "This question has changed or was already answered. Choose another question or start a new message.",
      };
    if (!value) return { kind: "blocked", reason: "Enter an answer." };
    // Keep paraphrases intact so the resumed workflow can interpret the user's words.
    const answer =
      match.choices.find((choice) => choice.toLowerCase() === value.toLowerCase()) ?? value;
    return {
      kind: "decision",
      value: { id: match.id, body: { version: target.version, decision: "answer", answer } },
    };
  }
  if (target.kind === "proposal" && value && !value.endsWith("?")) {
    const match = pending.find(
      (item) =>
        item.id === target.id && item.version === target.version && item.kind === "proposal",
    );
    if (!match)
      return {
        kind: "blocked",
        reason: "This proposal changed. Review the current version before deciding.",
      };
    return {
      kind: "decision",
      value: {
        id: match.id,
        body: {
          version: target.version,
          ...(explicitDecision.test(value)
            ? {decision: /^(approve|accept)/i.test(value) ? "approve" as const : "reject" as const}
            : {decision:"revise" as const,answer:value}),
        },
      },
    };
  }
  return { kind: "message" };
}

function outputItemId(raw: unknown, depth = 0): string | undefined {
  if (depth > 5 || !raw) return;
  if (typeof raw === "string") {
    try {
      return outputItemId(JSON.parse(raw), depth + 1);
    } catch {
      return;
    }
  }
  if (typeof raw !== "object") return;
  if (Array.isArray(raw)) {
    for (const element of raw) {
      const id = outputItemId(element, depth + 1);
      if (id) return id;
    }
    return;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.inboxItemId === "string") return obj.inboxItemId;
  if (
    ["proposal", "notification", "question"].includes(String(obj.kind)) &&
    typeof obj.id === "string"
  )
    return obj.id;
  if (obj.type === "text" && typeof obj.text === "string") {
    try {
      return outputItemId(JSON.parse(obj.text), depth + 1);
    } catch {
      return;
    }
  }
  return outputItemId(obj.item ?? obj.content ?? obj.structuredContent, depth + 1);
}
export function toolInboxItem(part: FlueConversationPart) {
  if (part.type !== "dynamic-tool" || part.state !== "output-available") return;
  const id = outputItemId(part.output);
  return id && /^[a-z\d-]{1,100}$/i.test(id) ? id : undefined;
}

export function gmailSourceLink(source?: string): string | undefined {
  if (!source) return;
  try {
    const url = new URL(source);
    if (
      url.origin === "https://mail.google.com" &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith("/mail/")
    )
      return url.href;
  } catch {
    /* Other source values are labels. */
  }
}
