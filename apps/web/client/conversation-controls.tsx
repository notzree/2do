import { useSearchTerm } from "./use-search-term.ts";
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { AtSign, GitBranch, Search } from "lucide-react";
import type { SideChat } from "@2do/api/chats";
import type { FlueConversationMessage } from "@flue/sdk";
import { api, queryClient } from "./query.ts";
import { inboxKey } from "./agent-inbox-api.ts";
import { Modal } from "./modal.tsx";
import { chatLocation, openAgents } from "./agents-navigation.ts";
import { chatsQuery, setChatScope, registerDraftChat } from "./chats.ts";

export const cleanMessage = (text: string) =>
  text
    .replace(/^\[2do turn [^\]]+\]\n/, "")
    .replace(/^\[Planner date [^\]]+\]\n\n/, "")
    .split("\n\n[Planner context:")[0]
    .replace(/\n\n\[Referenced conversations: [^\]]+\]$/, "");
export function BranchDialog({
  message,
  previous,
  close,
}: {
  message: FlueConversationMessage;
  previous?: FlueConversationMessage;
  close: () => void;
}) {
  const source = cleanMessage(
    message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"),
  ).slice(0, 4000);
  const exchange = previous
    ? [
        cleanMessage(previous.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")),
        source,
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 4000)
    : source;
  const [id] = useState(() => crypto.randomUUID()),
    [title, setTitle] = useState(() => source.slice(0, 70)),
    [excerpt, setExcerpt] = useState(exchange);
  const [copyStatus, setCopyStatus] = useState("");
  const branch = useMutation({
    mutationFn: async () =>
      api.POST("/api/chats/branch", { body: { id, title, excerpt, messageId: message.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey });
      close();
      openAgents(chatLocation(id));
    },
  });
  return (
    <Modal title="Continue in side chat" close={close}>
      <form
        className="editor agent-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          branch.mutate();
        }}
      >
        <label>
          Objective
          <input
            required
            maxLength={100}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Starting context
          <textarea
            required
            maxLength={4000}
            rows={5}
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
          />
        </label>
        <div className="actions">
          <button type="button" onClick={() => setExcerpt(exchange)}>
            Rebuild from exchange
          </button>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(excerpt)
                .then(() => setCopyStatus("Copied"))
                .catch(() => setCopyStatus("Select the starting context to copy it."))
            }
          >
            Copy context
          </button>
          <small role="status">{copyStatus}</small>
        </div>
        {branch.isError && <small role="alert">{branch.error.message}</small>}
        <button className="primary" disabled={branch.isPending || !title.trim() || !excerpt.trim()}>
          <GitBranch size={14} /> Create side chat
        </button>
      </form>
    </Modal>
  );
}

export function ConversationReferences({
  id,
  chats,
  scope,
  onClose,
}: {
  id: string;
  chats: SideChat[];
  scope: string[];
  onClose: () => void;
}) {
  const [source, setSource] = useState(id === "me" ? "active-sides" : "me"),
    [q, setQ] = useState("");
  const search = useSearchTerm(q);
  const options = [
    { id: "me", title: "Main chat" },
    { id: "active-sides", title: "Active side chats" },
    ...chats,
  ].filter((c) => c.id !== id);
  const matches = useQuery({
    queryKey: ["planner", "context", source, search],
    enabled: !!search,
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET("/api/agents/context", {
        params: { query: { chat: source, q: search! } },
        signal,
      });
      return { matches: data ?? [], indexing: response.headers.get("X-2do-Indexing") === "true" };
    },
    refetchInterval: (query) => (query.state.data?.indexing ? 2500 : false),
  });
  return (
    <Modal title="Reference a conversation" close={onClose}>
      <div className="editor agent-dialog">
        <label>
          Search in
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Find text
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search messages…"
          />
        </label>
        {q.trim() &&
          (matches.isError ? (
            <p role="alert">{matches.error.message}</p>
          ) : matches.isPending ? (
            <p role="status">Searching…</p>
          ) : matches.data?.matches.length ? (
            <ul className="context-results">
              {matches.data.matches.map((m) => (
                <li key={m.chat + m.messageId}>
                  <strong>{m.title}</strong>
                  <p>{m.excerpt}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setChatScope(id, [...new Set([...scope, m.chat])]);
                      onClose();
                    }}
                  >
                    Reference this chat
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      openAgents(
                        chatLocation(m.chat, { message: m.messageId, generation: m.generation }),
                      );
                    }}
                  >
                    View message ↗
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status">
              {matches.data?.indexing ? "Indexing conversation history…" : "No matching messages."}
            </p>
          ))}
        <button
          className="primary"
          onClick={() => {
            setChatScope(id, [...new Set([...scope, source])]);
            onClose();
          }}
        >
          <AtSign size={14} /> Reference {options.find((c) => c.id === source)?.title}
        </button>
      </div>
    </Modal>
  );
}

export function WorkspaceItemPicker({ chat, close }: { chat: string; close: () => void }) {
  const [q, setQ] = useState("");
  const search = useSearchTerm(q);
  const items = useInfiniteQuery({
    queryKey: ["planner", "inbox", "proposal-picker", search],
    enabled: search !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) =>
      (
        await api.GET("/api/agent/inbox", {
          params: { query: { view: "action", kind: "proposal", q: search || undefined, cursor: pageParam } },
          signal,
        })
      ).data!,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const rows = items.data?.pages.flatMap((p) => p.items) ?? [];
  const link = useMutation({
    mutationFn: async (itemId: string) => {
      await registerDraftChat(chat, rows.find((i) => i.id === itemId)?.title ?? "Workspace review");
      await api.PUT("/api/chats/{id}/items/{itemId}", { params: { path: { id: chat, itemId } } });
      return itemId;
    },
    onSuccess: async (item) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...inboxKey, "conversation", chat] }),
        queryClient.invalidateQueries({ queryKey: ["planner", "activity"] }),
        queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey }),
      ]);
      close();
      openAgents(chatLocation(chat, { item }));
    },
  });
  return (
    <Modal title="Link a workspace proposal" close={close}>
      <div className="editor agent-dialog">
        <label>
          Find a proposal
          <input
            type="search"
            placeholder="Search active proposals…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        {items.isPending && <small>Searching…</small>}
        {(items.error || link.error) && <p role="alert">{(items.error || link.error)?.message}</p>}
        {rows.map((item) => (
          <button
            className="workspace-picker-row"
            key={item.id}
            disabled={link.isPending}
            onClick={() => link.mutate(item.id)}
          >
            <Search size={14} />
            {item.title}
          </button>
        ))}
        {items.hasNextPage && (
          <button disabled={items.isFetchingNextPage} onClick={() => void items.fetchNextPage()}>
            Load more
          </button>
        )}
        {items.data && !rows.length && <p>No matching active proposals.</p>}
      </div>
    </Modal>
  );
}
