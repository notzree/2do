import { setActivePanel } from "./workspace-panels.ts";
import { dayKey } from "./calendar.ts";
import { create } from "zustand";
import { queryOptions } from "@tanstack/react-query";
import { createFlueClient, FlueExecutionError, type FlueClient } from "@flue/sdk";
import { chatList, sideChat, type SideChat } from "@2do/api/chats";
import { api, queryClient, refreshPlanner } from "./query.ts";

export const chatsQuery = queryOptions({
	queryKey: ["chats"],
	queryFn: async ({ signal }) => chatList.parse((await api.GET("/api/chats", { signal })).data),
});
type Composer = {
	draft: string;
	isNew?: boolean;
	busy?: boolean;
	admitting?: boolean;
	error?: string;
	retry?: { body: string; key: string; message: string };
	version?: number;
};
export const emptyComposer: Composer = { draft: "" };
export const useChats = create<{
	selected: string;
	composers: Record<string, Composer>;
	focus: number;
}>(() => ({ selected: "me", composers: {}, focus: 0 }));

function update(id: string, patch: Partial<Composer>) {
	useChats.setState((s) => ({
		composers: { ...s.composers, [id]: { ...emptyComposer, ...s.composers[id], ...patch } },
	}));
}
export function selectChat(id: string) {
	useChats.setState((s) => ({ selected: id, focus: s.focus + 1 }));
	setActivePanel({ kind: "chat" });
}
export function newSideChat() {
	const empty = Object.entries(useChats.getState().composers).find(
		([, c]) => c.isNew && !c.draft && !c.busy,
	);
	const id = empty?.[0] ?? crypto.randomUUID();
	update(id, { isNew: true });
	selectChat(id);
	return id;
}
export function setChatError(id: string, error: unknown) {
	update(id, { error: error instanceof Error ? error.message : "Could not reach the agent." });
}
export function setDraft(id: string, draft: string) {
	update(id, { draft });
}
export function chatClient(id: string): FlueClient {
	const client = createFlueClient({ url: "/api/agents/copilot/" + id });
	return { ...client, observe: (options) => client.observe({ limit: 200, ...options }) };
}
export async function sendChat(id: string, message: string) {
	const body = message.trim();
	const composer = useChats.getState().composers[id] ?? emptyComposer;
	if (!body || composer.busy) return;
	const retry =
		composer.retry?.body === body
			? composer.retry
			: {
					body,
					key: crypto.randomUUID(),
					message: `[Planner date ${dayKey(new Date())}, ${Intl.DateTimeFormat().resolvedOptions().timeZone}]\n\n${body}`,
				};
	update(id, { draft: "", busy: true, admitting: true, error: undefined, retry });
	const client = chatClient(id);
	try {
		if (composer.isNew) {
			const { data } = await api.PUT("/api/chats/{id}", {
				params: { path: { id } },
				body: { title: body.slice(0, 100) },
			});
			const chat = sideChat.parse(data);
			queryClient.setQueryData<SideChat[]>(chatsQuery.queryKey, (old) => [
				chat,
				...(old ?? []).filter((c) => c.id !== id),
			]);
			update(id, { isNew: false });
			void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey });
		}
		const receipt = await client.send({
			message: { kind: "user", body: retry.message },
			idempotencyKey: retry.key,
		});
		update(id, { version: (composer.version ?? 0) + 1, admitting: false, retry: undefined });
		// Keep following this submission even when the sidebar switches conversations.
		await client.wait({
			...receipt,
			streamUrl: new URL("/api/agents/copilot/" + id, location.origin).href,
		});
	} catch (e) {
		if (e instanceof FlueExecutionError && e.failure === "aborted") return;
		const unadmitted = useChats.getState().composers[id].admitting;
		update(id, {
			error: e instanceof Error ? e.message : "Could not reach the agent.",
			...(unadmitted && { draft: body }),
		});
	} finally {
		update(id, { busy: false, admitting: false });
		void refreshPlanner();
	}
}
