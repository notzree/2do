import { dispatch, type AgentDispatchRequest } from "@flue/runtime";
import { createAgentRouter } from "@flue/runtime/routing";
import { Copilot } from "./copilot.ts";
import { sideConversation } from "./chat-identity.ts";
export type WorkspaceInput = Omit<AgentDispatchRequest, "id" | "initialData"> & {
  idempotencyKey: string;
};
export const workspaceDispatch = (owner: string, chat: string, input: WorkspaceInput) =>
  dispatch(Copilot, {
    ...input,
    id:
      chat === "me"
        ? owner
        : chat.startsWith("routine:")
          ? chat + ":" + owner
          : sideConversation(owner, chat),
  });
const router = createAgentRouter(Copilot);
export function readWorkspaceHistory(env: Env, owner: string, chat: string, before: string | null) {
  const id =
    chat === "me"
      ? owner
      : chat.startsWith("routine:")
        ? chat + ":" + owner
        : sideConversation(owner, chat);
  const url = new URL("/" + encodeURIComponent(id), "https://conversation.internal");
  url.searchParams.set("view", "history");
  url.searchParams.set("limit", "80");
  if (before) url.searchParams.set("before", before);
  return router.fetch(new Request(url), env);
}
