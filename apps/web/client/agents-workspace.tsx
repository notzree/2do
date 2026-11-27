import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { inboxPage } from "@2do/api/agent-inbox";
import type { SideChat } from "@2do/api/chats";
import { LazyChatbar } from "./lazy-chatbar.tsx";
import { api, queryClient } from "./query.ts";
import { chatsQuery, newSideChat, useChats } from "./chats.ts";
import { activityOptions } from "./agent-activity.ts";
import { useSearchTerm } from "./use-search-term.ts";
import { agentsHref, chatLocation, openAgents, type AgentLocation } from "./agents-navigation.ts";
import { inboxItemQuery } from "./agent-inbox-api.ts";
import { Modal } from "./modal.tsx";
import { boundCommand, type Command } from "./preferences.ts";
import { usePreferences } from "./preference-store.ts";
import "./agents-workspace.css";

const nav = [
  { page: "main", label: "Main", title: "Main chat" },
  { page: "attention", label: "Needs Attention", title: "Needs attention" },
  { page: "chats", label: "Side chats", title: "Side chats" },
  { page: "activity", label: "All activity", title: "All activity" },
  { page: "archived", label: "Archived", title: "Archived chats" },
] as const;
function Jump({
  to,
  children,
  className,
  current,
}: {
  to: AgentLocation;
  children: React.ReactNode;
  className?: string;
  current?: boolean;
}) {
  return (
    <a
      href={agentsHref(to)}
      className={className}
      aria-current={current ? "page" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openAgents(to);
      }}
    >
      {children}
    </a>
  );
}
function dateTime(at: string) {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function ListView({ all, chats }: { all: boolean; chats: SideChat[] }) {
  const [q, setQ] = useState("");
  const search = useSearchTerm(q);
  const queue = useInfiniteQuery({
    queryKey: ["planner", "inbox", "attention", search],
    enabled: !all && search !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      inboxPage.parse(
        (
          await api.GET("/api/agent/inbox", {
            params: { query: { view: "action", q: search || undefined, cursor: pageParam } },
            signal,
          })
        ).data,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const activity = useInfiniteQuery({ ...activityOptions(), enabled: all });
  const sourceName = (id: string) => chats.find((c) => c.id === id)?.title ?? "Main chat";
  const result = all ? activity : queue;
  return (
    <div className="agents-list-pane">
      {!all && (
        <label className="agents-search">
          <Search size={16} />
          <input
            type="search"
            aria-label="Search unresolved decisions"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search unresolved decisions…"
          />
        </label>
      )}
      {result.isPending ? (
        <p role="status">Loading…</p>
      ) : result.isError ? (
        <p role="alert">
          {result.error.message} <button onClick={() => void result.refetch()}>Retry</button>
        </p>
      ) : null}
      {all
        ? activity.data?.pages
            .flatMap((p) => p.items)
            .map((e) => (
              <Jump
                key={e.id}
                to={chatLocation(e.chat, {
                  event: e.id,
                  item: e.itemId ?? undefined,
                  message:
                    e.kind === "branch" && e.chat !== "me" ? undefined : (e.messageId ?? undefined),
                  generation: e.generation ?? undefined,
                })}
                className="agent-list-row"
              >
                <span className="activity-symbol">
                  {e.kind === "milestone" ? (
                    <Sparkles />
                  ) : e.kind === "run" ? (
                    <Activity />
                  ) : e.kind === "branch" ? (
                    <GitBranch />
                  ) : (
                    <Clock3 />
                  )}
                </span>
                <span>
                  <strong>{e.title}</strong>
                  <small>
                    {sourceName(e.chat)} · {e.body}
                  </small>
                </span>
                <time>{dateTime(e.at)}</time>
                <ChevronRight size={15} />
              </Jump>
            ))
        : queue.data?.pages
            .flatMap((p) => p.items)
            .map((item) => (
              <Jump
                key={item.id}
                to={chatLocation(item.conversation ?? "me", { item: item.id })}
                className="agent-list-row"
              >
                <span className="activity-symbol pending">
                  <CircleDot />
                </span>
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {sourceName(item.conversation ?? "me")} ·{" "}
                    {item.kind === "question" ? "Question" : "Proposal"}
                  </small>
                </span>
                <time>{dateTime(item.createdAt)}</time>
                <ChevronRight size={15} />
              </Jump>
            ))}
      {result.isSuccess && !result.data.pages[0]?.items.length && (
        <div className="agents-empty">
          <Check />
          <h2>{all ? "No activity yet" : q ? "No matching requests" : "You’re all caught up"}</h2>
        </div>
      )}
      {result.hasNextPage && (
        <button
          className="plain"
          disabled={result.isFetchingNextPage}
          onClick={() => void result.fetchNextPage()}
        >
          Load more
        </button>
      )}
    </div>
  );
}
function ChatDirectory({ chats, archived }: { chats: SideChat[]; archived: boolean }) {
  const [q, setQ] = useState("");
  const rows = chats.filter((chat) => {
    if (!!chat.archivedAt !== archived) return false;
    let i = 0;
    const needle = q.trim().toLowerCase();
    for (const ch of chat.title.toLowerCase()) if (ch === needle[i]) i++;
    return i === needle.length;
  });
  return (
    <div className="agents-list-pane">
      <label className="agents-search">
        <Search size={16} />
        <input
          aria-label="Find conversation"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a conversation…"
        />
      </label>
      {rows.map((chat) => (
        <Jump key={chat.id} to={chatLocation(chat.id)} className="agent-list-row">
          <span className="activity-symbol">
            <GitBranch />
          </span>
          <span>
            <strong>{chat.title}</strong>
            <small>
              {chat.branch ? "Branched from Main chat" : "Independent conversation"}
              {chat.needsAttention ? " · " + chat.needsAttention + " pending" : ""}
            </small>
          </span>
          <time>
            {dateTime(
              new Date(chat.archivedAt ?? chat.lastActivity ?? chat.createdAt).toISOString(),
            )}
          </time>
          <ChevronRight size={15} />
        </Jump>
      ))}
      {!rows.length && (
        <div className="agents-empty">
          <FolderOpen />
          <h2>
            {q ? "No matching conversations" : archived ? "No archived chats" : "No side chats yet"}
          </h2>
          {!archived && !q && <button onClick={newSideChat}>Start a side chat</button>}
        </div>
      )}
    </div>
  );
}
function ChatSettings({ chat, close }: { chat: SideChat; close: () => void }) {
  const [title, setTitle] = useState(chat.title),
    [headline, setHeadline] = useState(""),
    [summary, setSummary] = useState(""),
    [reporting, setReporting] = useState(false);
  const [itemId, setItemId] = useState("");
  const [notebookDay, setNotebookDay] = useState("");
  const choices = useQuery({
    queryKey: ["planner", "inbox", "reportable", chat.id],
    enabled: reporting,
    queryFn: async ({ signal }) =>
      inboxPage.parse(
        (
          await api.GET("/api/agent/inbox", {
            params: { query: { chat: chat.id, limit: 100 } },
            signal,
          })
        ).data,
      ).items,
  });
  const key = "2do.milestone." + chat.id;
  const [occurrence] = useState(() => {
    try {
      const saved = sessionStorage.getItem(key) ?? crypto.randomUUID();
      sessionStorage.setItem(key, saved);
      return saved;
    } catch {
      return crypto.randomUUID();
    }
  });

  const update = useMutation({
    mutationFn: async (changes: { title?: string; archived?: boolean }) =>
      api.PATCH("/api/chats/{id}", { params: { path: { id: chat.id } }, body: changes }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey });
      close();
    },
  });
  const report = useMutation({
    mutationFn: async () =>
      api.POST("/api/chats/{id}/milestones", {
        params: { path: { id: chat.id } },
        body: {
          title: headline,
          body: summary,
          occurrence: itemId || occurrence,
          ...(notebookDay && { notebookDay }),
          ...(itemId && { itemId }),
        },
      }),
    onSuccess: async ({ data }) => {
      try {
        sessionStorage.removeItem(key);
      } catch {}
      await queryClient.invalidateQueries({ queryKey: ["planner", "activity"] });
      close();
      openAgents({ page: "main", event: data?.id });
    },
  });
  return (
    <Modal title={reporting ? "Report back to Main" : "Conversation settings"} close={close}>
      {reporting ? (
        <form
          className="editor agent-dialog"
          onSubmit={(e) => {
            e.preventDefault();
            report.mutate();
          }}
        >
          <label>
            Related outcome
            <select
              value={itemId}
              onChange={(e) => {
                const id = e.target.value;
                setItemId(id);
                const item = choices.data?.find((i) => i.id === id);
                if (item) {
                  setHeadline(item.title);
                  setSummary(item.answer ?? item.body);
                }
              }}
            >
              <option value="">Conversation milestone</option>
              {choices.data?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title} · {i.status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Milestone
            <input
              required
              value={headline}
              maxLength={160}
              onChange={(e) => setHeadline(e.target.value)}
            />
          </label>
          <label>
            Outcome
            <textarea
              rows={4}
              required
              maxLength={2000}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </label>
          <label>
            Notebook page (optional)
            <input
              type="date"
              value={notebookDay}
              onChange={(e) => setNotebookDay(e.target.value)}
            />
          </label>
          <button className="primary" disabled={report.isPending}>
            Report to Main
          </button>
        </form>
      ) : (
        <div className="editor agent-dialog">
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
          </label>
          <div className="actions">
            <button
              disabled={!title.trim() || update.isPending}
              onClick={() => update.mutate({ title })}
            >
              Save title
            </button>
            <button
              disabled={update.isPending}
              onClick={() => update.mutate({ archived: !chat.archivedAt })}
            >
              {chat.archivedAt ? "Restore chat" : "Archive chat"}
            </button>
            <button onClick={() => setReporting(true)}>Report back to Main</button>
          </div>
        </div>
      )}
      {(report.error || update.error) && (
        <p role="alert">{(report.error || update.error)?.message}</p>
      )}
    </Modal>
  );
}
function ResolveItem({ id, action }: { id: string; action?: AgentLocation["action"] }) {
  const item = useQuery(inboxItemQuery(id));
  useEffect(() => {
    if (item.data)
      openAgents(chatLocation(item.data.conversation ?? "me", { item: id, action }), true);
  }, [id, action, item.data]);
  return <p role="status">{item.error?.message ?? "Opening workspace decision…"}</p>;
}
export function AgentsWorkspaceView({
  route,
  runCommand,
}: {
  route: AgentLocation;
  runCommand: (command: Command) => void;
}) {
  const list = useQuery(chatsQuery),
    chats = list.data ?? [];
  const [settings, setSettings] = useState(false);
  const bindings = usePreferences((s) => s.bindings);
  const navigate = useEffectEvent(runCommand);
  const enabled = usePreferences((s) => s.keysEnabled);
  const root = useRef<HTMLElement>(null);
  const chat = chats.find((c) => c.id === route.id),
    chatId = route.page === "chat" ? route.id : "me";
  const isChat = route.page === "chat" || route.page === "main";
  const title =
    route.page === "chat"
      ? (chat?.title ?? "New side chat")
      : (nav.find((n) => n.page === route.page)?.title ?? "Workspace item");
  useLayoutEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [route.page, route.id]);
  useEffect(() => {
    setSettings(false);
    if (isChat && chatId) useChats.setState({ selected: chatId });
  }, [route.page, chatId, isChat]);
  useEffect(() => {
    if (!enabled) return;
    let prefix = "",
      last = 0;
    const key = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        document.querySelector("dialog[open]") ||
        (e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      const pair = (performance.now() - last < 900 ? prefix : "") + e.key;
      last = performance.now();
      prefix = e.key;
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        openAgents({ page: "chats" });
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>('[aria-label="Find conversation"]')?.focus(),
        );
      } else if (e.ctrlKey || e.metaKey || e.altKey) return;
      else if (pair.startsWith("g") && pair.length === 2) {
        const command = boundCommand(bindings, e.key);
        // Agents has its own g m for Main chat. Shared destinations honor the notebook keymap.
        if (command && ["week", "calendar", "agents", "copilot", "settings"].includes(command))
          navigate(command);
        else if (pair === "gm" || pair === "gi")
          openAgents({ page: pair === "gm" ? "main" : "attention" });
        else return;
        e.preventDefault();
      } else if (pair === "za") {
        const group =
          (e.target as Element)?.closest("details") ??
          root.current?.querySelector("details.operation-group");
        if (group) {
          e.preventDefault();
          (group as HTMLDetailsElement).open = !(group as HTMLDetailsElement).open;
        }
      } else if (pair === " b") {
        root.current
          ?.querySelector<HTMLButtonElement>(
            "[data-message-id]:focus-within .message-branch, .chat-message:last-of-type .message-branch",
          )
          ?.click();
      } else if (pair === "]d" || pair === "[d") {
        e.preventDefault();
        void (async () => {
          const rows = [] as { id: string; conversation?: string }[];
          let cursor: string | undefined;
          do {
            const page = inboxPage.parse(
              (
                await api.GET("/api/agent/inbox", {
                  params: { query: { view: "action", limit: 100, cursor } },
                })
              ).data,
            );
            rows.push(...page.items);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          if (!rows.length) {
            openAgents({ page: "attention" });
            return;
          }
          const from = rows.findIndex((i) => i.id === route.item),
            step = pair === "]d" ? 1 : -1;
          const next =
            rows[
              from < 0
                ? step === 1
                  ? 0
                  : rows.length - 1
                : (from + step + rows.length) % rows.length
            ];
          openAgents(chatLocation(next.conversation ?? "me", { item: next.id }));
        })().catch(() => openAgents({ page: "attention" }));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled, bindings, route.item]);
  return (
    <main ref={root} className="agents-workspace" aria-label="Agents" tabIndex={-1}>
      <header className="notebook-top">
        <nav className="notebook-crumb agent-sections" aria-label="Agents navigation">
          <span><Sparkles size={14} aria-hidden="true" />Agent</span>
          {nav.map(({ page, label }) => (
            <Jump key={page} to={{ page }}
              current={page === route.page ||
                (page === "chats" && route.page === "chat" && !chat?.archivedAt) ||
                (page === "archived" && !!chat?.archivedAt)}>
              {label}
            </Jump>
          ))}
        </nav>
      </header>
      <section className="agents-content">
        <header className="agents-page-head">
          <div>
            <h1>{title}</h1>
            {route.page === "chat" && chat && (
              <small>
                <GitBranch size={13} /> Independent context · Created{" "}
                {new Date(chat.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </small>
            )}
          </div>
          {route.page === "chat" && chat && (
            <button
              aria-label="Conversation settings"
              title="Conversation settings"
              onClick={() => setSettings(true)}
            >
              <MoreHorizontal size={18} />
            </button>
          )}
          {route.page === "chats" && (
            <button onClick={newSideChat}>
              <Plus size={15} />
              New chat
            </button>
          )}
        </header>
        {settings && chat && <ChatSettings chat={chat} close={() => setSettings(false)} />}
        {list.isError && <p role="alert">{list.error.message}</p>}
        {isChat ? (
          <LazyChatbar route={route} />
        ) : route.page === "item" ? (
          <ResolveItem id={route.id ?? ""} action={route.action} />
        ) : route.page === "attention" || route.page === "activity" ? (
          <ListView key={route.page} all={route.page === "activity"} chats={chats} />
        ) : (
          <ChatDirectory key={route.page} chats={chats} archived={route.page === "archived"} />
        )}
      </section>
    </main>
  );
}
