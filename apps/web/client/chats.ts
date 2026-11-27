import {currentAgents,openAgents,chatLocation} from "./agents-navigation.ts";
import { captureDraftSelection } from "./agent-editor.ts";
import { setActivePanel } from "./workspace-panels.ts";
import { followDeviceSubmission,tabIdentity } from "./device-delivery.ts";
import { usePreferences } from "./preference-store.ts";
import { dayKey } from "./calendar.ts";
import { create } from "zustand";
import { queryOptions } from "@tanstack/react-query";
import { createFlueClient, FlueExecutionError, type FlueClient } from "@flue/sdk";
import { chatList, sideChat, type SideChat } from "@2do/api/chats";
import { api, queryClient, refreshPlanner, getVerifiedScope } from "./query.ts";

export const chatsQuery = queryOptions({
	queryKey: ["chats"],
  refetchInterval:30000,
	queryFn: async ({ signal }) => chatList.parse((await api.GET("/api/chats", { params:{query:{view:"directory"}}, signal })).data),
});
type Composer = {
	scope?: string[];
	replyTarget?: import("./agent-inbox-api.ts").ChatReplyTarget;
	draft: string;
	attachment?: {id:string;name:string};
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
let selectedTaskForChat: string | undefined;
export function captureChatTask(taskId?:string) { selectedTaskForChat = taskId; }
export function selectChat(id: string) {
	if(currentAgents()) {useChats.setState({selected:id});openAgents(chatLocation(id));return;}
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
export function setChatReplyTarget(id:string, target:Composer["replyTarget"]) { update(id,{replyTarget:target,error:undefined}); }
export function setDraft(id: string, draft: string, replyTarget?:Composer["replyTarget"]) {
	update(id, { draft, ...(replyTarget ? {replyTarget}:{}), error:undefined });
}
export function setChatScope(id:string,scope:string[]) {update(id,{scope,replyTarget:{kind:"message"}});}
export function setAttachment(id:string, attachment?: Composer["attachment"]) { update(id,{attachment}); }
export function chatClient(id: string,scope?:string[],claim?:string): FlueClient {
	const client = createFlueClient({ url: "/api/agents/copilot/" + id, headers:{...(claim&&{"X-2do-Device-Claim":claim}),...(scope?.length && {"X-2do-Context-Scope":JSON.stringify(scope)}),...(getVerifiedScope() && {"X-Planner-Scope":getVerifiedScope()!})} });
	return { ...client, observe: (options) => client.observe({ limit: 200, ...options }) };
}
export async function registerDraftChat(id:string,title:string){
  if(!useChats.getState().composers[id]?.isNew)return;
  const {data}=await api.PUT("/api/chats/{id}",{params:{path:{id}},body:{title:title.slice(0,100)}});
  const chat=sideChat.parse(data);
  queryClient.setQueryData<SideChat[]>(chatsQuery.queryKey,old=>[chat,...(old??[]).filter(c=>c.id!==id)]);
  update(id,{isNew:false});
  void queryClient.invalidateQueries({queryKey:chatsQuery.queryKey});
}
export async function sendChat(id: string, message: string) {
	const body = message.trim();
	const composer = useChats.getState().composers[id] ?? emptyComposer;
	if ((!body && !composer.attachment) || composer.busy) return;
	const request = body || "Use this attached image.";
	const notebook = !currentAgents();
	const draft = notebook ? captureDraftSelection() : undefined;
	const context = [draft?.text && "Selected notebook text " + JSON.stringify(draft.text), notebook && selectedTaskForChat && "Selected task " + selectedTaskForChat, composer.attachment && "Attached notebook image " + composer.attachment.id].filter(Boolean);
	const scope=composer.scope?.length?composer.scope:/\b(?:search|find|look up|check)\b.*\b(?:my |all )?side chats?\b/i.test(request)?["active-sides"]:/\b(?:search|find|look up|check)\b.*\bmain chat\b/i.test(request)?["me"]:[];
  const authored = request + (scope.length ? "\n\n[Referenced conversations: "+scope.join(", ")+"]" : "") + (context.length ? "\n\n[Planner context: " + context.join(", ") + "]" : "");
	const prefs = usePreferences.getState();
	const originUrl = location.href;
	const owner = getVerifiedScope();
	const retry =
		composer.retry?.body === authored
			? composer.retry
			: {
					body: authored,
					key: crypto.randomUUID(),
					message: `[Planner date ${dayKey(new Date())}, ${Intl.DateTimeFormat().resolvedOptions().timeZone}]\n\n${authored}`,
				};
	update(id, { draft: "", replyTarget:undefined, busy: true, admitting: true, error: undefined, retry });
	const client = chatClient(id,scope,await tabIdentity());
	try {
		await registerDraftChat(id,request);
		const receipt = await client.send({
			message: { kind: "user", body: retry.message },
			idempotencyKey: retry.key,
		});
		update(id, { version: (composer.version ?? 0) + 1, admitting: false, retry: undefined, attachment: undefined, scope: undefined });
		// Keep following this submission even when the sidebar switches conversations.
		if (owner && getVerifiedScope() === owner) {
			await followDeviceSubmission(owner,id,receipt,prefs,originUrl,client,draft);
		} else {
			await client.wait({...receipt,streamUrl:new URL("/api/agents/copilot/"+id,location.origin).href});
		}
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
