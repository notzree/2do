import { createContext, useCallback, useMemo } from "react";
import { queryOptions, useQueries, type UseQueryResult } from "@tanstack/react-query";
import { inboxItem, inboxItemBatchSize, type InboxItem } from "@2do/api/agent-inbox";
import type { FlueConversationMessage } from "@flue/sdk";
import type { WorkspaceEvent } from "@2do/api/agents-workspace";
import { inboxKey, toolInboxItem } from "./agent-inbox-api.ts";
import { api } from "./query.ts";

type Card = { item?: InboxItem; error?: string; retry: () => void };
export const ConversationInbox = createContext<ReadonlyMap<string, Card>>(new Map());

export function useConversationCards(messages: FlueConversationMessage[], events: WorkspaceEvent[], target?: string) {
  const messageIds = useMemo(() => [...new Set(
    messages.flatMap(message => message.parts.map(toolInboxItem)).filter((id): id is string => !!id),
  )], [messages]);
  const batches = useMemo(() => {
    const unique = [...new Set([...messageIds, ...events.flatMap(e => e.itemId ? [e.itemId] : []), ...(target ? [target] : [])])];
    const groups: string[][] = [];
    for (let i = 0; i < unique.length; i += inboxItemBatchSize)
      groups.push(unique.slice(i, i + inboxItemBatchSize));
    return groups;
  }, [messageIds, events, target]);
  const combine = useCallback((results: UseQueryResult<InboxItem[]>[]) => {
    const cards = new Map<string, Card>();
    results.forEach((result, index) => {
      const items = new Map(result.data?.map(item => [item.id, item]));
      for (const id of batches[index]) {
        const item = items.get(id);
        cards.set(id, {
          item,
          error: result.error?.message ?? (result.isSuccess && !item ? "Inbox item not found." : undefined),
          retry: result.refetch,
        });
      }
    });
    return cards;
  }, [batches]);
  const cards = useQueries({
    queries: batches.map(batch => queryOptions({
      queryKey: [...inboxKey, "items", batch],
      queryFn: async ({ signal }) => inboxItem.array().parse(
        (await api.POST("/api/agent/inbox-items", { body: { ids: batch }, signal })).data,
      ),
      refetchInterval: 20_000,
    })),
    combine,
  });
  return { cards, items: messageIds.map(id => cards.get(id)) };
}
