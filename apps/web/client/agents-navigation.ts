export type AgentPage = "main" | "attention" | "activity" | "chats" | "archived" | "chat" | "item";
export type AgentLocation = {
  page: AgentPage;
  id?: string;
  item?: string;
  message?: string;
  event?: string;
  generation?: string;
  action?: "read" | "unread" | "archive" | "undoTime";
};
export function agentsHref({ page, id, item, message, event, generation, action }: AgentLocation) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ item, message, event, generation, action }))
    if (value) params.set(key, value);
  const path =
    page === "main"
      ? ""
      : page === "chat" || page === "item"
        ? "/" + page + "/" + encodeURIComponent(id ?? "")
        : "/" + page;
  return "/app/agents" + path + (params.size ? "?" + params : "");
}
export function openAgents(route: AgentLocation = { page: "main" }, replace = false) {
  const url = agentsHref(route);
  if (location.pathname + location.search === url) return;
  const previous = currentAgents()
    ? history.state?.agentsReturn
    : location.pathname + location.search;
  const state = { agentsReturn: previous };
  if (replace) history.replaceState(state, "", url);
  else history.pushState(state, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function currentAgents(): AgentLocation | null {
  const [, app, agents, segment, rawId] = location.pathname.split("/");
  if (app !== "app" || agents !== "agents") return null;
  const page: AgentPage = ["attention", "activity", "chat", "chats", "archived", "item"].includes(
    segment,
  )
    ? (segment as AgentPage)
    : "main";
  const p = new URLSearchParams(location.search),
    action = p.get("action");
  return {
    page,
    event: p.get("event") ?? undefined,
    id: rawId ? decodeURIComponent(rawId) : undefined,
    item: p.get("item") ?? undefined,
    message: p.get("message") ?? undefined,
    generation: p.get("generation") ?? undefined,
    action:
      action === "read" || action === "unread" || action === "archive" || action === "undoTime"
        ? action
        : undefined,
  };
}
export const chatLocation = (
  chat: string,
  extra: Pick<AgentLocation, "item" | "message" | "generation" | "action" | "event"> = {},
): AgentLocation => ({
  page: chat === "me" ? "main" : "chat",
  id: chat === "me" ? undefined : chat,
  ...extra,
});

export function notebookReturnHref(): string | undefined {
  const url = history.state?.agentsReturn;
  if (typeof url === "string" && /^\/app(?:\/(?:week|day|calendar|settings))?\/?(?:\?|$)/.test(url)) return url;
}

export function returnToNotebook(fallback: () => void) {
  const url = notebookReturnHref();
  if (!url) return fallback();
  history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
