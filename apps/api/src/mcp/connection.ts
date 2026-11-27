import { defineMcpConnection } from "@flue/runtime";

import type { ChatCalendar } from "../agents/chat-calendar.ts";

export type AgentTurn = { calendar?: ChatCalendar; origin?: "chat" | "scheduled"; submission: string; replaces?: string };

// Flue caches a connection by name. Read current turn metadata when the cached
// transport sends a request. Each conversation processes its deliveries in order.
const turns = new Map<string, AgentTurn>();
export function setAgentTurn(conversation: string, turn: AgentTurn | undefined) {
  if (turn) turns.set(conversation, turn);
  else turns.delete(conversation);
}
export function agentTurn(conversation: string) {
  return turns.get(conversation);
}

export function plannerConnection(
  planners: Env["USER_PLANNER"],
  identity: string,
  conversation?: string,
) {
  return defineMcpConnection({
    name: "planner",
    url: "https://planner.internal/mcp",
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (conversation) {
        request.headers.set("x-2do-agent-chat", encodeURIComponent(conversation));
        const turn = agentTurn(conversation);
        if (turn) {
          request.headers.set("x-2do-agent-submission", turn.submission);
          if (turn.calendar) {
            request.headers.set("x-2do-agent-date", turn.calendar.date);
            request.headers.set("x-2do-agent-zone", turn.calendar.timeZone);
          }
          if (turn.origin) request.headers.set("x-2do-agent-origin", turn.origin);
          if (turn.replaces) request.headers.set("x-2do-agent-replaces", turn.replaces);
        }
      }
      return planners.getByName(identity).fetch(request);
    },
  });
}
